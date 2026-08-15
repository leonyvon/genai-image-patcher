// services/sound.ts — 生成完成提示音（Web Audio API 合成，无外部文件）
let audioCtx: AudioContext | null = null;

/**
 * 播放一段简短的双音提示（A5 → D6，柔和正弦波）。
 * 浏览器自动播放策略下需用户交互后才可发声——点击"开始生成"已是用户手势，
 * 生成完成时播放通常不受阻；仍用 try/catch 兜底。
 */
export function playCompletionSound(): void {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    const now = audioCtx.currentTime;
    const notes = [880, 1174.66]; // A5 → D6
    notes.forEach((freq, i) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.15;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  } catch (e) {
    console.warn('playCompletionSound failed', e);
  }
}
