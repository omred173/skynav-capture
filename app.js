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
    return body;
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

  async function shareOrDownload(jpg, json) {
    var files = [jpg, json];
    if (navigator.canShare) {
      try {
        if (navigator.canShare({ files: files })) {
          await navigator.share({ files: files, title: jpg.name });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    downloadFile(jpg);
    downloadFile(json);
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
      lastPair = { jpg: jpg, json: json };
      lastName = jpgName;
      lastEl.textContent = lastName;
      reshareBtn.hidden = false;
      await shareOrDownload(jpg, json);
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
    shareOrDownload(lastPair.jpg, lastPair.json).catch(function (err) {
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
