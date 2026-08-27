/* SkyNav capture-web — DeviceMotion sidecar, no location API. */
(function () {
  "use strict";

  var G = 9.80665;
  var STATIC_G = 0.05;
  var SCHEMA = "skynav.capture.web.v1";
  var STACK_N = 12;
  var STACK_MODE = "mean";
  var NIGHT_CONSTRAINT_KEYS = [
    "exposureMode",
    "exposureCompensation",
    "iso",
    "exposureTime",
    "focusMode",
    "focusDistance",
    "frameRate",
    "whiteBalanceMode",
    "torch",
    "zoom",
  ];

  var video = document.getElementById("preview");
  var blank = document.getElementById("blank");
  var statusEl = document.getElementById("status");
  var secureEl = document.getElementById("secure");
  var enableBtn = document.getElementById("enable");
  var shutterBtn = document.getElementById("shutter");
  var shutterWrap = document.getElementById("shutter-wrap");
  var shutterLabel = document.getElementById("shutter-label");
  var lastEl = document.getElementById("last");
  var reshareBtn = document.getElementById("reshare");
  var nightBtn = document.getElementById("night");

  var stream = null;
  var motionOn = false;
  var lastAig = null;
  var lastStaticAig = null;
  var lastUser = null;
  var lastUserMagG = null;
  var lastStatic = null;
  var lastRate = null;
  var lastMotionTs = null;
  var lastPair = null;
  var lastName = "";
  var nightOn = false;
  var lastExposureAttempt = null;
  var lastCameraLock = {
    attempt: "unknown",
    enumerate_count: 0,
    labelHash: null,
  };

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || "";
  }

  function vec3(src) {
    if (!src) return null;
    var x = src.x;
    var y = src.y;
    var z = src.z;
    if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    return { x: x, y: y, z: z };
  }

  function mag(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }

  function norm(v) {
    var n = mag(v);
    if (!(n > 1e-9)) return null;
    return { x: v.x / n, y: v.y / n, z: v.z / n };
  }

  function copy(v) {
    return { x: v.x, y: v.y, z: v.z };
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === "number") {
      return screen.orientation.angle;
    }
    if (typeof window.orientation === "number") return window.orientation;
    return null;
  }

  function utcISO() {
    return new Date().toISOString();
  }

  function stemFromUtc(iso) {
    return "skynav_" + iso.replace(/[-:]/g, "").replace(".", "");
  }

  function getTrack() {
    if (!stream || !stream.getVideoTracks) return null;
    var tracks = stream.getVideoTracks();
    return tracks && tracks.length ? tracks[0] : null;
  }

  function onMotion(ev) {
    var aig = vec3(ev.accelerationIncludingGravity);
    var acc = vec3(ev.acceleration);
    var rate = null;
    if (ev.rotationRate) {
      var a = ev.rotationRate.alpha;
      var b = ev.rotationRate.beta;
      var g = ev.rotationRate.gamma;
      if (typeof a === "number" && typeof b === "number" && typeof g === "number") {
        rate = { alpha: a, beta: b, gamma: g };
      }
    }
    if (aig) lastAig = copy(aig);
    if (acc) {
      lastUser = copy(acc);
      lastUserMagG = mag(acc) / G;
      lastStatic = lastUserMagG <= STATIC_G;
      if (lastStatic && aig) lastStaticAig = copy(aig);
    } else {
      lastUser = null;
      lastUserMagG = null;
      lastStatic = null;
    }
    if (rate) lastRate = rate;
    lastMotionTs = typeof ev.timeStamp === "number" ? ev.timeStamp : null;
    motionOn = true;
    var imuLine = lastStatic === false ? "IMU: not static" : "IMU: ready";
    if (lastAig) {
      var nn = norm(lastAig);
      imuLine += nn
        ? " · ĝ " + nn.x.toFixed(2) + " " + nn.y.toFixed(2) + " " + nn.z.toFixed(2)
        : "";
    }
    if (lastUserMagG != null) imuLine += " · |a| " + lastUserMagG.toFixed(3) + " g";
    if (nightOn) imuLine += " · לילה ×" + STACK_N;
    setStatus(imuLine, lastStatic === false ? "warn" : "");
  }

  async function requestMotion() {
    if (typeof DeviceMotionEvent === "undefined") {
      throw new Error("DeviceMotionEvent missing");
    }
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      var state = await DeviceMotionEvent.requestPermission();
      if (state !== "granted") throw new Error("motion denied: " + state);
    }
    window.addEventListener("devicemotion", onMotion, { passive: true });
  }

  function videoConstraints(extra) {
    extra = extra || {};
    var c = {
      facingMode: extra.facingExact ? { exact: "environment" } : { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    };
    if (extra.deviceId) c.deviceId = { exact: extra.deviceId };
    if (nightOn) c.frameRate = { ideal: 10, max: 24 };
    return c;
  }

  function stopStream() {
    if (!stream) return;
    var tracks = stream.getTracks ? stream.getTracks() : [];
    for (var i = 0; i < tracks.length; i++) {
      try {
        tracks[i].stop();
      } catch (err) {}
    }
    stream = null;
    if (video) video.srcObject = null;
  }

  async function attachStream(s) {
    stream = s;
    video.srcObject = stream;
    await video.play();
    blank.classList.add("hidden");
  }

  async function openVideo(extra) {
    var s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(extra),
    });
    await attachStream(s);
    return s;
  }

  function normLabel(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[-_./]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function labelKind(label) {
    var n = normLabel(label);
    if (!n) return "empty";
    if (/\bfront\b|\buser\b|\bselfie\b|קדמית|frontal|delantera/.test(n)) return "front";
    if (
      /ultra\s*wide|ultrawide|\bultra\b|אולטרה|רחב במיוחד|надширок|ultra grand|ultra weit/.test(n)
    ) {
      return "ultrawide";
    }
    if (/\btele\b|telephoto|טלפוטו/.test(n)) return "tele";
    if (/\bdual\b|\btriple\b|desk view|כפולה|משולשת/.test(n)) return "virtual";
    if (/\bback\b|\brear\b|\benvironment\b|אחורית|traseira|trasera|rückkamera|arrière/.test(n)) {
      return "main";
    }
    return "other";
  }

  function pickPreferred(videos) {
    var main = null;
    var virtual = null;
    var i;
    var k;
    for (i = 0; i < videos.length; i++) {
      k = labelKind(videos[i].label);
      if (k === "main" && !main) main = videos[i];
      if (k === "virtual" && !virtual) virtual = videos[i];
    }
    if (main) return { device: main, attempt: "main", kind: "main" };
    if (virtual) return { device: virtual, attempt: "environment", kind: "virtual" };
    return null;
  }

  async function listVideoInputs() {
    if (!navigator.mediaDevices.enumerateDevices) return [];
    var all = await navigator.mediaDevices.enumerateDevices();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].kind === "videoinput") out.push(all[i]);
    }
    return out;
  }

  function currentDeviceId() {
    var track = getTrack();
    if (!track || typeof track.getSettings !== "function") return null;
    try {
      var s = track.getSettings() || {};
      return typeof s.deviceId === "string" && s.deviceId ? s.deviceId : null;
    } catch (err) {
      return null;
    }
  }

  async function applyWideZoom(kind) {
    var track = getTrack();
    if (!track || typeof track.applyConstraints !== "function") return;
    var caps = {};
    if (typeof track.getCapabilities === "function") {
      try {
        caps = track.getCapabilities() || {};
      } catch (err) {}
    }
    var z = caps.zoom;
    var supported = supportedConstraints();
    if (!(z && typeof z === "object") && !supported.zoom) return;
    var min = z && typeof z.min === "number" && isFinite(z.min) ? z.min : 1;
    var max = z && typeof z.max === "number" && isFinite(z.max) ? z.max : 2;
    var want;
    if (kind === "main") {
      want = 1;
    } else if (max >= 2) {
      want = 2;
    } else {
      want = 1;
    }
    if (want < 1) return;
    if (want < min) want = min;
    if (want > max) want = max;
    if (want < 1) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: want }] });
    } catch (err1) {
      try {
        await track.applyConstraints({ zoom: want });
      } catch (err2) {}
    }
  }

  async function requestCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia missing");
    }
    lastCameraLock = { attempt: "unknown", enumerate_count: 0, labelHash: null };

    await openVideo(null);

    var videos = [];
    try {
      videos = await listVideoInputs();
    } catch (err) {
      videos = [];
    }
    lastCameraLock.enumerate_count = videos.length;

    var pick = pickPreferred(videos);
    var curId = currentDeviceId();

    if (pick && pick.device && pick.device.deviceId) {
      lastCameraLock.attempt = pick.attempt;
      lastCameraLock.labelHash = hashDeviceId(pick.device.label);
      if (pick.device.deviceId !== curId) {
        try {
          stopStream();
          await openVideo({ deviceId: pick.device.deviceId, facingExact: true });
        } catch (errExact) {
          try {
            stopStream();
            await openVideo({ deviceId: pick.device.deviceId, facingExact: false });
          } catch (errId) {
            stopStream();
            await openVideo(null);
            lastCameraLock.attempt = videos.length ? "environment" : "unknown";
          }
        }
      }
    } else {
      lastCameraLock.attempt = videos.length ? "environment" : "unknown";
      var t = getTrack();
      if (t && typeof t.applyConstraints === "function") {
        try {
          await t.applyConstraints({ facingMode: { exact: "environment" } });
        } catch (err) {}
      }
    }

    var kind = pick && pick.kind ? pick.kind : "unknown";
    await applyWideZoom(kind);
    if (nightOn) await applyNightConstraints();
  }

  function supportedConstraints() {
    try {
      if (navigator.mediaDevices && typeof navigator.mediaDevices.getSupportedConstraints === "function") {
        return navigator.mediaDevices.getSupportedConstraints() || {};
      }
    } catch (err) {}
    return {};
  }

  function pickCap(caps, key, fallback) {
    var c = caps && caps[key];
    if (!c || typeof c !== "object") return fallback;
    if (typeof c.max === "number" && isFinite(c.max)) return c.max;
    return fallback;
  }

  function stampConstraintSubset(src) {
    var out = {};
    if (!src) return out;
    for (var i = 0; i < NIGHT_CONSTRAINT_KEYS.length; i++) {
      var k = NIGHT_CONSTRAINT_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    return out;
  }

  async function applyNightConstraints() {
    var report = {
      requested: false,
      supported: {},
      capabilities: {},
      attempted: {},
      applied: null,
      error: null,
      torch: false,
      note: "WebKit IDL still FIXMEs exposureMode/exposureCompensation/iso/exposureTime/focusMode; attempted as ideal/advanced. Never torch.",
    };
    var supported = supportedConstraints();
    var supportedNight = {};
    for (var i = 0; i < NIGHT_CONSTRAINT_KEYS.length; i++) {
      var k = NIGHT_CONSTRAINT_KEYS[i];
      if (supported[k]) supportedNight[k] = true;
    }
    report.supported = supportedNight;

    var track = getTrack();
    if (!track) {
      report.error = "no_track";
      lastExposureAttempt = report;
      return report;
    }

    var caps = {};
    if (typeof track.getCapabilities === "function") {
      try {
        caps = track.getCapabilities() || {};
      } catch (err) {}
    }
    report.capabilities = stampConstraintSubset(caps);

    var attempted = {};
    if (supported.torch || Object.prototype.hasOwnProperty.call(caps, "torch")) attempted.torch = false;
    if (supported.exposureMode || caps.exposureMode) attempted.exposureMode = "manual";
    if (supported.exposureCompensation || caps.exposureCompensation) {
      attempted.exposureCompensation = pickCap(caps, "exposureCompensation", 2);
    }
    if (supported.iso || caps.iso) {
      var isoMax = pickCap(caps, "iso", 1600);
      attempted.iso = Math.min(isoMax, 3200);
    }
    if (supported.exposureTime || caps.exposureTime) {
      attempted.exposureTime = pickCap(caps, "exposureTime", 667);
    }
    if (supported.focusMode || caps.focusMode) attempted.focusMode = "manual";
    if (supported.focusDistance || caps.focusDistance) {
      var fd = pickCap(caps, "focusDistance", null);
      if (fd != null) attempted.focusDistance = fd;
    }
    if (supported.frameRate || caps.frameRate) attempted.frameRate = 10;

    report.attempted = attempted;
    report.requested = Object.keys(attempted).length > 0;

    if (report.requested && typeof track.applyConstraints === "function") {
      try {
        await track.applyConstraints({ advanced: [attempted] });
      } catch (err1) {
        try {
          await track.applyConstraints(attempted);
        } catch (err2) {
          report.error = String(err2 && err2.message ? err2.message : err2);
        }
      }
    }

    if (typeof track.getSettings === "function") {
      try {
        report.applied = stampConstraintSubset(track.getSettings() || {});
      } catch (err) {}
    }

    lastExposureAttempt = report;
    return report;
  }

  async function applyDayConstraints() {
    var track = getTrack();
    if (!track || typeof track.applyConstraints !== "function") return;
    try {
      await track.applyConstraints({ frameRate: { ideal: 30 } });
    } catch (err) {}
  }

  function setNight(on) {
    nightOn = !!on;
    nightBtn.setAttribute("aria-pressed", nightOn ? "true" : "false");
    shutterWrap.classList.toggle("night", nightOn);
    shutterLabel.textContent = nightOn ? "NIGHT ×" + STACK_N : "SHUTTER";
  }

  async function onNightToggle() {
    setNight(!nightOn);
    if (!stream) {
      setStatus(nightOn ? "לילה: ייחסן " + STACK_N + " פריימים אחרי הפעלת מצלמה." : "מצב יום.", "");
      return;
    }
    try {
      if (nightOn) {
        setStatus("לילה: מנסה חשיפה…", "");
        var report = await applyNightConstraints();
        var keys = Object.keys(report.supported);
        setStatus(
          "לילה ×" + STACK_N + " mean. iOS supported: " + (keys.length ? keys.join(", ") : "none of the night keys") + ".",
          ""
        );
      } else {
        await applyDayConstraints();
        setStatus("מצב יום.", "");
      }
    } catch (err) {
      setStatus("Night constraints: " + (err && err.message ? err.message : err), "warn");
    }
  }

  async function enableSensors() {
    if (!window.isSecureContext) {
      secureEl.classList.add("show");
      setStatus("Not a secure context. Open over HTTPS.", "bad");
      return;
    }
    enableBtn.disabled = true;
    try {
      await requestMotion();
      await requestCamera();
      shutterBtn.disabled = false;
      enableBtn.hidden = true;
      var lockLine = "lock " + lastCameraLock.attempt + " · n=" + lastCameraLock.enumerate_count;
      setStatus(
        nightOn
          ? "Camera on. " + lockLine + ". לילה ×" + STACK_N + ". Hold still, then shutter."
          : "Camera on. " + lockLine + ". Hold still, then shutter.",
        ""
      );
    } catch (err) {
      enableBtn.disabled = false;
      setStatus("Permission failed: " + (err && err.message ? err.message : err), "bad");
    }
  }

  function buildSidecar(iso, stem, filename, extra) {
    extra = extra || {};
    var raw = extra.gravity || lastStaticAig || lastAig;
    var gravity = raw ? copy(raw) : null;
    var ghat = gravity ? norm(gravity) : null;
    var body = {
      schema: SCHEMA,
      honesty: "no location API",
      utc: iso,
      imu: gravity ? "devicemotion_including_gravity" : "unavailable",
      attitude_reference_frame: "DeviceMotionEvent.accelerationIncludingGravity",
      not_cmdevicemotion_gravity: true,
      gps_exif: "not_requested",
      image_filename: filename,
      sidecar_stem: stem,
      lens: "browser_environment",
      codec: "image/jpeg",
      image_source: extra.image_source || "canvas_from_video",
      gravity_units: "m/s2",
      static_threshold_g: STATIC_G,
    };
    if (gravity) {
      body.gravity = gravity;
      body.accelerationIncludingGravity = copy(gravity);
    }
    if (ghat) body.gravity_normalized = ghat;
    if (lastUser) {
      body.userAcceleration = copy(lastUser);
      body.userAcceleration_units = "m/s2";
    }
    if (lastUserMagG != null) body.userAcceleration_magnitude_g = lastUserMagG;
    if (typeof lastStatic === "boolean") body.static = lastStatic;
    if (lastRate) {
      body.rotationRate = lastRate;
      body.rotationRate_units = "deg/s";
    }
    if (lastMotionTs != null) body.timestamp_motion = lastMotionTs;
    var ang = screenAngle();
    if (ang != null) body.screen_orientation_deg = ang;
    stampCamera(body);
    if (extra.night) {
      body.night = true;
      body.stack_n = extra.stack_n;
      body.stack_mode = extra.stack_mode;
      body.torch = false;
      if (lastExposureAttempt) {
        body.exposure_attempted = lastExposureAttempt.attempted;
        body.exposure_supported = lastExposureAttempt.supported;
        if (lastExposureAttempt.capabilities && Object.keys(lastExposureAttempt.capabilities).length) {
          body.exposure_capabilities = lastExposureAttempt.capabilities;
        }
        if (lastExposureAttempt.applied) body.exposure_applied = lastExposureAttempt.applied;
        if (lastExposureAttempt.error) body.exposure_error = lastExposureAttempt.error;
        if (lastExposureAttempt.note) body.exposure_note = lastExposureAttempt.note;
      } else {
        body.exposure_attempted = {};
      }
    }
    return body;
  }

  function hashDeviceId(id) {
    if (typeof id !== "string" || !id) return null;
    var bytes = new TextEncoder().encode(id);
    var hex = (crc32(bytes) >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  function stampCamera(body) {
    body.camera_lock_attempt = lastCameraLock.attempt || "unknown";
    if (typeof lastCameraLock.enumerate_count === "number") {
      body.enumerate_count = lastCameraLock.enumerate_count;
    }
    if (video && video.videoWidth) body.videoWidth = video.videoWidth;
    if (video && video.videoHeight) body.videoHeight = video.videoHeight;
    var track = getTrack();
    var label = "";
    if (track && typeof track.label === "string") label = track.label;
    var lhash = hashDeviceId(label) || lastCameraLock.labelHash;
    if (!track || typeof track.getSettings !== "function") {
      if (lhash) {
        body.mediaTrackSettings = { deviceLabel_hash: lhash };
      }
      return;
    }
    var s;
    try {
      s = track.getSettings() || {};
    } catch (err) {
      if (lhash) body.mediaTrackSettings = { deviceLabel_hash: lhash };
      return;
    }
    var settings = {};
    if (typeof s.width === "number" && isFinite(s.width)) settings.width = s.width;
    if (typeof s.height === "number" && isFinite(s.height)) settings.height = s.height;
    if (typeof s.facingMode === "string" && s.facingMode) settings.facingMode = s.facingMode;
    if (typeof s.aspectRatio === "number" && isFinite(s.aspectRatio)) settings.aspectRatio = s.aspectRatio;
    if (typeof s.zoom === "number" && isFinite(s.zoom)) settings.zoom = s.zoom;
    if (typeof s.frameRate === "number" && isFinite(s.frameRate)) settings.frameRate = s.frameRate;
    var hid = hashDeviceId(s.deviceId);
    if (hid) settings.deviceId_hash = hid;
    if (lhash) settings.deviceLabel_hash = lhash;
    body.mediaTrackSettings = settings;
  }

  function nextVideoFrame() {
    return new Promise(function (resolve) {
      if (video && typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(function () {
          resolve();
        });
        return;
      }
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          resolve();
        });
      });
    });
  }

  function canvasToJpeg(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) reject(new Error("jpeg failed"));
        else resolve(blob);
      }, "image/jpeg", 0.92);
    });
  }

  function canvasBlob() {
    var w = video.videoWidth;
    var h = video.videoHeight;
    if (!w || !h) throw new Error("preview not ready");
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    return canvasToJpeg(canvas);
  }

  async function stackCanvasBlob(n, mode) {
    var w = video.videoWidth;
    var h = video.videoHeight;
    if (!w || !h) throw new Error("preview not ready");
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var npx = w * h * 4;
    var acc = mode === "max" ? new Uint8ClampedArray(npx) : new Float32Array(npx);
    var got = 0;
    for (var i = 0; i < n; i++) {
      await nextVideoFrame();
      ctx.drawImage(video, 0, 0, w, h);
      var img = ctx.getImageData(0, 0, w, h);
      var src = img.data;
      var p;
      if (mode === "max") {
        if (i === 0) acc.set(src);
        else {
          for (p = 0; p < npx; p += 4) {
            if (src[p] > acc[p]) acc[p] = src[p];
            if (src[p + 1] > acc[p + 1]) acc[p + 1] = src[p + 1];
            if (src[p + 2] > acc[p + 2]) acc[p + 2] = src[p + 2];
            acc[p + 3] = 255;
          }
        }
      } else if (i === 0) {
        for (p = 0; p < npx; p++) acc[p] = src[p];
      } else {
        for (p = 0; p < npx; p++) acc[p] += src[p];
      }
      got++;
      setStatus("לילה " + got + "/" + n, "");
    }
    var out = ctx.createImageData(w, h);
    var dst = out.data;
    if (mode === "max") {
      dst.set(acc);
    } else {
      for (p = 0; p < npx; p++) dst[p] = Math.round(acc[p] / got);
      for (p = 3; p < npx; p += 4) dst[p] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return canvasToJpeg(canvas);
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
  function u32(n) {
    return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  }

  function zipStore(entries) {
    var local = [];
    var central = [];
    var offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var name = new TextEncoder().encode(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      var lh = new Uint8Array(30 + name.length + data.length);
      lh.set([0x50, 0x4b, 0x03, 0x04], 0);
      lh.set(u16(20), 4);
      lh.set(u16(0), 6);
      lh.set(u16(0), 8);
      lh.set(u16(0), 10);
      lh.set(u16(0), 12);
      lh.set(u32(crc), 14);
      lh.set(u32(data.length), 18);
      lh.set(u32(data.length), 22);
      lh.set(u16(name.length), 26);
      lh.set(u16(0), 28);
      lh.set(name, 30);
      lh.set(data, 30 + name.length);
      local.push(lh);
      var ch = new Uint8Array(46 + name.length);
      ch.set([0x50, 0x4b, 0x01, 0x02], 0);
      ch.set(u16(20), 4);
      ch.set(u16(20), 6);
      ch.set(u16(0), 8);
      ch.set(u16(0), 10);
      ch.set(u16(0), 12);
      ch.set(u16(0), 14);
      ch.set(u32(crc), 16);
      ch.set(u32(data.length), 20);
      ch.set(u32(data.length), 24);
      ch.set(u16(name.length), 28);
      ch.set(u16(0), 30);
      ch.set(u16(0), 32);
      ch.set(u16(0), 34);
      ch.set(u16(0), 36);
      ch.set(u32(0), 38);
      ch.set(u32(offset), 42);
      ch.set(name, 46);
      central.push(ch);
      offset += lh.length;
    }
    var centralSize = central.reduce(function (s, x) { return s + x.length; }, 0);
    var end = new Uint8Array(22);
    end.set([0x50, 0x4b, 0x05, 0x06], 0);
    end.set(u16(0), 4);
    end.set(u16(0), 6);
    end.set(u16(entries.length), 8);
    end.set(u16(entries.length), 10);
    end.set(u32(centralSize), 12);
    end.set(u32(offset), 16);
    end.set(u16(0), 20);
    var total = offset + centralSize + 22;
    var out = new Uint8Array(total);
    var p = 0;
    for (i = 0; i < local.length; i++) { out.set(local[i], p); p += local[i].length; }
    for (i = 0; i < central.length; i++) { out.set(central[i], p); p += central[i].length; }
    out.set(end, p);
    return out;
  }

  async function fileBytes(file) {
    var buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function pairZip(jpg, json, stem) {
    var bytes = zipStore([
      { name: jpg.name, data: await fileBytes(jpg) },
      { name: json.name, data: await fileBytes(json) },
    ]);
    return new File([bytes], stem + ".zip", { type: "application/zip" });
  }

  function downloadFile(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  async function shareOrDownload(zip) {
    var files = [zip];
    if (navigator.canShare) {
      try {
        if (navigator.canShare({ files: files })) {
          await navigator.share({ files: files, title: zip.name });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    downloadFile(zip);
  }

  async function onShutter() {
    shutterBtn.disabled = true;
    try {
      var iso = utcISO();
      var stem = stemFromUtc(iso);
      var jpgName = stem + ".jpg";
      var jsonName = stem + ".json";
      var gravitySnap = lastStaticAig ? copy(lastStaticAig) : (lastAig ? copy(lastAig) : null);
      var jpeg;
      var extra = {};
      if (nightOn) {
        await applyNightConstraints();
        jpeg = await stackCanvasBlob(STACK_N, STACK_MODE);
        extra.night = true;
        extra.stack_n = STACK_N;
        extra.stack_mode = STACK_MODE;
        extra.image_source = "canvas_from_video_stack";
        extra.gravity = gravitySnap;
      } else {
        jpeg = await canvasBlob();
      }
      var sidecar = buildSidecar(iso, stem, jpgName, extra);
      var jpg = new File([jpeg], jpgName, { type: "image/jpeg" });
      var json = new File([JSON.stringify(sidecar, null, 2)], jsonName, { type: "application/json" });
      var zip = await pairZip(jpg, json, stem);
      lastPair = { zip: zip };
      lastName = zip.name;
      lastEl.textContent = lastName + " — שלח את ה-zip לצ'אט, לא את התמונה";
      reshareBtn.hidden = false;
      await shareOrDownload(zip);
      setStatus(
        (sidecar.static === false ? "Saved (not static). " : "Saved. ") +
          (sidecar.stack_n ? "stack " + sidecar.stack_n + " " + sidecar.stack_mode + ". " : "") +
          lastName,
        sidecar.static === false ? "warn" : ""
      );
    } catch (err) {
      setStatus("Capture failed: " + (err && err.message ? err.message : err), "bad");
    } finally {
      shutterBtn.disabled = !stream;
    }
  }

  function onReshare() {
    if (!lastPair) return;
    shareOrDownload(lastPair.zip).catch(function (err) {
      setStatus("Share failed: " + (err && err.message ? err.message : err), "bad");
    });
  }

  if (!window.isSecureContext) secureEl.classList.add("show");

  enableBtn.addEventListener("click", enableSensors);
  shutterBtn.addEventListener("click", onShutter);
  reshareBtn.addEventListener("click", onReshare);
  nightBtn.addEventListener("click", onNightToggle);

  if ("serviceWorker" in navigator) {
    var swOpts = { scope: "./" };
    if (typeof ServiceWorkerRegistration !== "undefined") swOpts.updateViaCache = "none";
    navigator.serviceWorker.register("./sw.js", swOpts).catch(function () {});
    navigator.serviceWorker.getRegistration("./").then(function (reg) {
      if (reg && typeof reg.update === "function") return reg.update();
    }).catch(function () {});
  }
})();
