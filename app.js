/* SkyNav capture-web — DeviceMotion sidecar, no location API. */
(function () {
  "use strict";

  var G = 9.80665;
  var STATIC_G = 0.05;
  var SCHEMA = "skynav.capture.web.v1";

  var video = document.getElementById("preview");
  var blank = document.getElementById("blank");
  var statusEl = document.getElementById("status");
  var secureEl = document.getElementById("secure");
  var enableBtn = document.getElementById("enable");
  var shutterBtn = document.getElementById("shutter");
  var lastEl = document.getElementById("last");
  var reshareBtn = document.getElementById("reshare");

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

  async function requestCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia missing");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
      },
    });
    video.srcObject = stream;
    await video.play();
    blank.classList.add("hidden");
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
      setStatus("Camera on. Hold still, then shutter.", "");
    } catch (err) {
      enableBtn.disabled = false;
      setStatus("Permission failed: " + (err && err.message ? err.message : err), "bad");
    }
  }

  function buildSidecar(iso, stem, filename) {
    var raw = lastStaticAig || lastAig;
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
      image_source: "canvas_from_video",
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
    if (video && video.videoWidth) body.videoWidth = video.videoWidth;
    if (video && video.videoHeight) body.videoHeight = video.videoHeight;
    var track = null;
    if (stream && stream.getVideoTracks) {
      var tracks = stream.getVideoTracks();
      if (tracks && tracks.length) track = tracks[0];
    }
    if (!track || typeof track.getSettings !== "function") return;
    var s;
    try {
      s = track.getSettings() || {};
    } catch (err) {
      return;
    }
    var settings = {};
    if (typeof s.width === "number" && isFinite(s.width)) settings.width = s.width;
    if (typeof s.height === "number" && isFinite(s.height)) settings.height = s.height;
    if (typeof s.facingMode === "string" && s.facingMode) settings.facingMode = s.facingMode;
    if (typeof s.aspectRatio === "number" && isFinite(s.aspectRatio)) settings.aspectRatio = s.aspectRatio;
    if (typeof s.zoom === "number" && isFinite(s.zoom)) settings.zoom = s.zoom;
    var hid = hashDeviceId(s.deviceId);
    if (hid) settings.deviceId_hash = hid;
    body.mediaTrackSettings = settings;
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
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) reject(new Error("jpeg failed"));
        else resolve(blob);
      }, "image/jpeg", 0.92);
    });
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
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
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
      var jpeg = await canvasBlob();
      var sidecar = buildSidecar(iso, stem, jpgName);
      var jpg = new File([jpeg], jpgName, { type: "image/jpeg" });
      var json = new File([JSON.stringify(sidecar, null, 2)], jsonName, { type: "application/json" });
      var zip = await pairZip(jpg, json, stem);
      lastPair = { zip: zip };
      lastName = zip.name;
      lastEl.textContent = lastName + " — שלח את ה-zip לצ'אט, לא את התמונה";
      reshareBtn.hidden = false;
      await shareOrDownload(zip);
      setStatus(
        (sidecar.static === false ? "Saved (not static). " : "Saved. ") + lastName,
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(function () {});
  }
})();
