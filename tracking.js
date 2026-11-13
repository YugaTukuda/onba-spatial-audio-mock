import { clamp, angleDelta, poseFromMatrix } from './scene.js';

export class HeadTracker {
  constructor(video, overlay, onUpdate) {
    this.video = video;
    this.overlay = overlay;
    this.onUpdate = onUpdate;
    this.model = null;
    this.stream = null;
    this.running = false;
    this.starting = false;
    this.frame = null;
    this.lastVideoTime = -1;
    this.lastInferenceTime = -1;
    this.smoothed = null;
    this.neutral = null;
    this.lastPose = null;
    this.sensitivity = 1;
    this.invert = false;
    this.offset = { yaw: 0, pitch: 0 };
    this.generation = 0;
  }
  async start() {
    if (this.running || this.starting) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('カメラはHTTPSまたはlocalhostで利用できます');
    this.starting = true;
    const generation = ++this.generation;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }, audio: false });
      if (generation !== this.generation) { this.stream.getTracks().forEach(track => track.stop()); return; }
      this.video.srcObject = this.stream;
      await this.video.play();
      if (!this.model) {
        const { FaceLandmarker, FilesetResolver } = await import('./vendor/vision_bundle.mjs');
        const vision = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', import.meta.url).href);
        this.model = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: new URL('./vendor/face_landmarker.task', import.meta.url).href, delegate: 'CPU' },
          runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: .55, minFacePresenceConfidence: .55, minTrackingConfidence: .55
        });
      }
      if (generation !== this.generation) return;
      this.running = true;
      this.neutral = this.smoothed = this.lastPose = null;
      this.lastVideoTime = -1;
      this.lastInferenceTime = -1;
      this.frame = requestAnimationFrame(t => this.tick(t));
    } catch (error) {
      this.stop();
      if (error.name === 'NotAllowedError') throw new Error('カメラが許可されていません。ブラウザのカメラ設定を確認してください');
      if (error.name === 'NotFoundError') throw new Error('利用できるカメラが見つかりません');
      if (error.name === 'NotReadableError') throw new Error('カメラを開けません。他のアプリで使用されていないか確認してください');
      throw new Error(`顔の向きの推定を開始できませんでした: ${error.message}`);
    } finally { this.starting = false; }
  }
  tick(timestamp) {
    if (!this.running) return;
    if (document.hidden) { this.frame = requestAnimationFrame(t => this.tick(t)); return; }
    if (timestamp - this.lastInferenceTime > 65 && this.video.readyState >= 2 && this.lastVideoTime !== this.video.currentTime) {
      this.lastInferenceTime = timestamp;
      this.lastVideoTime = this.video.currentTime;
      try {
        const result = this.model.detectForVideo(this.video, timestamp);
        const pose = poseFromMatrix(result.facialTransformationMatrixes?.[0]?.data);
        if (pose) {
          this.lastPose = pose;
          if (!this.neutral) this.neutral = { ...pose };
          if (!this.smoothed) this.smoothed = { ...pose };
          this.smoothed.yaw += angleDelta(pose.yaw, this.smoothed.yaw) * .22;
          this.smoothed.pitch += (pose.pitch - this.smoothed.pitch) * .22;
          this.offset = {
            yaw: clamp(angleDelta(this.smoothed.yaw, this.neutral.yaw) * this.sensitivity * (this.invert ? -1 : 1), -150, 150),
            pitch: clamp((this.smoothed.pitch - this.neutral.pitch) * this.sensitivity, -60, 60)
          };
          this.onUpdate({ found: true, ...this.offset });
        } else this.onUpdate({ found: false, ...this.offset });
        this.drawLandmarks(result.faceLandmarks?.[0]);
      } catch (error) {
        this.stop();
        this.onUpdate({ error: '顔の推定が停止しました。カメラを再度有効にしてください' });
        return;
      }
    }
    this.frame = requestAnimationFrame(t => this.tick(t));
  }
  calibrate() {
    if (!this.lastPose) return false;
    this.neutral = { ...this.lastPose };
    this.smoothed = { ...this.lastPose };
    this.offset = { yaw: 0, pitch: 0 };
    return true;
  }
  drawLandmarks(landmarks) {
    const canvas = this.overlay;
    const width = this.video.videoWidth || 480, height = this.video.videoHeight || 360;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    if (!landmarks) return;
    // Match object-fit:cover so the overlay remains aligned with the video.
    const rect = this.video.getBoundingClientRect();
    const scale = Math.max(rect.width / width, rect.height / height);
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
    canvas.style.left = `${(rect.width - width * scale) / 2}px`;
    canvas.style.top = `${(rect.height - height * scale) / 2}px`;
    ctx.strokeStyle = '#c3e6b8';
    ctx.fillStyle = '#c3e6b8';
    ctx.lineWidth = 1.5;
    const oval = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10];
    ctx.beginPath();
    oval.forEach((n, i) => { const p = landmarks[n]; i ? ctx.lineTo(p.x * width, p.y * height) : ctx.moveTo(p.x * width, p.y * height); });
    ctx.stroke();
    [1,4,33,263,61,291,199,168].forEach(n => { const p = landmarks[n]; ctx.beginPath(); ctx.arc(p.x * width, p.y * height, 2, 0, Math.PI * 2); ctx.fill(); });
  }
  stop() {
    this.generation++;
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.offset = { yaw: 0, pitch: 0 };
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
  dispose() { this.stop(); this.model?.close(); this.model = null; }
}
