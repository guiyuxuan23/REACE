import { element, zh } from './copy.ts';

export function speakText(text: string, feedback: HTMLElement) {
  const synthesis = window.speechSynthesis;
  const voice = synthesis?.getVoices().find(item => item.localService && /^zh/i.test(item.lang));
  if (!voice) { feedback.textContent = zh.speechUnavailable; return; }
  const message = new SpeechSynthesisUtterance(text);
  message.voice = voice;
  message.lang = voice.lang;
  message.onerror = () => { feedback.textContent = zh.speechUnavailable; };
  synthesis.cancel();
  synthesis.speak(message);
}

export function setupCamera() {
  const video = element<HTMLVideoElement>('camera');
  const open = element<HTMLButtonElement>('camera-open');
  const close = element<HTMLButtonElement>('camera-close');
  const status = element('camera-status');
  let stream: MediaStream | undefined;
  let generation = 0;

  function stop(message = '摄像头已关闭。') {
    generation++;
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    video.srcObject = null;
    video.hidden = true;
    close.hidden = true;
    open.disabled = false;
    status.textContent = message;
  }

  open.onclick = async () => {
    const current = ++generation;
    status.textContent = '正在等待摄像头权限。';
    close.hidden = false;
    open.disabled = true;
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      if (current !== generation) { next.getTracks().forEach(track => track.stop()); return; }
      stream = next;
      video.srcObject = next;
      video.hidden = false;
      await video.play();
      if (current !== generation) return;
      next.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (current === generation) stop();
      }, { once: true }));
      status.textContent = '仅预览。没有抓拍、保留照片或分析妆效。';
    } catch {
      if (current === generation) stop(zh.mediaError);
    }
  };
  close.onclick = () => { stop(); open.focus(); };
  addEventListener('pagehide', () => { if (!close.hidden) stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !close.hidden) stop(); });
  return stop;
}
