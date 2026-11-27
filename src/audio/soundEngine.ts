import {
  AmbientSoundConfig,
  AmbientSoundId,
  AudioSettings,
  AudioSlotConfig,
  AudioSlotId,
  BuiltInSfxId,
  QuestionSlide,
  SlideAudioClip,
  TemplateSettings,
  TimingSettings,
  computeProjectTimeline,
  getEndCardDuration,
  getIntroHookDuration,
  getSlidesContentDuration,
  getTotalDuration,
} from '../types/quiz';
import {
  decodeAiPresenterAudioBuffer,
  getAiPresenterPlaybackWindows,
} from '../canvas/aiPresenterMedia';

export const BUILTIN_SFX_OPTIONS: { id: BuiltInSfxId; label: string }[] = [
  { id: 'none', label: 'بدون صوت' },
  { id: 'impactBoom', label: 'ضربة سينمائية عميقة (Impact Boom 💥)' },
  { id: 'countdownAlarm', label: 'صفارة تحدي سريعة (Challenge Alarm 🚨)' },
  { id: 'mysterySparkle', label: 'وميض غموض وتشويق (Mystery Sparkle ✨)' },
  { id: 'arcadeLevelUp', label: 'انطلاقة ألعاب حماسية (Arcade Level Up 🎮)' },
  { id: 'glitchSnap', label: 'صدمة رقمية سريعة (Glitch Snap ⚡)' },
  { id: 'softPop', label: 'فقاعة القناة (Pop)' },
  { id: 'whoosh', label: 'سحب هوائي (Whoosh)' },
  { id: 'click', label: 'نقرة احترافية (Click)' },
  { id: 'channelTick', label: 'تكتكة العداد الكلاسيكي (القناة)' },
  { id: 'tick', label: 'تكتكة ساعة خفيفة (Tick)' },
  { id: 'suspenseRiser', label: 'تشويق قبل الجواب (نبض + تصاعد)' },
  { id: 'chime', label: 'رنة تنبيه لطيفة (Chime)' },
  { id: 'successFanfare', label: 'نغمة الإجابة الصحيحة (Success)' },
  { id: 'calmPulse', label: 'نبضة موسيقية هادئة' },
];

export interface RenderedExportAudio {
  buffer: AudioBuffer;
  speechIntervals: Array<{ start: number; end: number }>;
}

interface ScheduledVoiceItem {
  start: number;
  buffer: AudioBuffer;
  volume: number;
  maxEnd: number;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private ctxCaches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
  private bgNodes = new WeakMap<BaseAudioContext, { gain: GainNode; baseVolume: number }>();
  private ambientNodes = new WeakMap<
    BaseAudioContext,
    { gain: GainNode; baseVolume: number; autoDuck: boolean }
  >();
  private decodedDurations = new Map<string, number>();
  private activeSfxSources = new Set<AudioBufferSourceNode>();
  private activeVoiceSource: AudioBufferSourceNode | null = null;
  private activeVoiceGain: GainNode | null = null;
  private activeAiVoiceSource: AudioBufferSourceNode | null = null;
  private activeAiVoiceGain: GainNode | null = null;
  private activeBgSource: AudioBufferSourceNode | null = null;
  private activeBgGain: GainNode | null = null;
  private activeAmbientSource: AudioBufferSourceNode | null = null;
  private activeAmbientGain: GainNode | null = null;
  private voiceAnalyser: AnalyserNode | null = null;
  private voiceAnalyserBuf: Uint8Array<ArrayBuffer> | null = null;

  private getCacheForContext(ctx: BaseAudioContext): Map<string, AudioBuffer> {
    let map = this.ctxCaches.get(ctx);
    if (!map) {
      map = new Map<string, AudioBuffer>();
      this.ctxCaches.set(ctx, map);
    }
    return map;
  }

  private trackSourceIfPreview(
    ctx: BaseAudioContext,
    src: AudioBufferSourceNode,
    channel: 'sfx' | 'voice' | 'aiPresenter' = 'sfx',
    gainNode?: GainNode
  ): void {
    if (ctx !== this.ctx) return;

    if (channel === 'aiPresenter') {
      this.stopAiPresenterAudio();
      this.activeAiVoiceSource = src;
      this.activeAiVoiceGain = gainNode ?? null;
      src.onended = () => {
        if (this.activeAiVoiceSource === src) {
          this.activeAiVoiceSource = null;
          this.activeAiVoiceGain = null;
        }
      };
      return;
    }

    if (channel === 'voice') {
      this.stopActiveVoice();
      this.activeVoiceSource = src;
      this.activeVoiceGain = gainNode ?? null;
      src.onended = () => {
        if (this.activeVoiceSource === src) {
          this.activeVoiceSource = null;
          this.activeVoiceGain = null;
        }
      };
      return;
    }

    this.activeSfxSources.add(src);
    src.onended = () => {
      this.activeSfxSources.delete(src);
    };
  }

  public stopAiPresenterAudio(): void {
    if (this.activeAiVoiceSource) {
      try {
        this.activeAiVoiceSource.stop();
        this.activeAiVoiceSource.disconnect();
      } catch {
        // already stopped
      }
      this.activeAiVoiceSource = null;
    }
    if (this.activeAiVoiceGain) {
      try {
        this.activeAiVoiceGain.disconnect();
      } catch {
        // already disconnected
      }
      this.activeAiVoiceGain = null;
    }
  }

  public getLiveVoiceAmplitude(): number {
    if (!this.voiceAnalyser || (!this.activeVoiceSource && !this.activeAiVoiceSource)) {
      return 0;
    }
    if (!this.voiceAnalyserBuf || this.voiceAnalyserBuf.length !== this.voiceAnalyser.frequencyBinCount) {
      this.voiceAnalyserBuf = new Uint8Array(this.voiceAnalyser.frequencyBinCount);
    }
    this.voiceAnalyser.getByteTimeDomainData(this.voiceAnalyserBuf);
    let sumSq = 0;
    const buf = this.voiceAnalyserBuf;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, buf.length));
    return Math.max(0, Math.min(1, rms * 3.4));
  }

  public stopActiveVoice(): void {
    if (this.activeVoiceSource) {
      try {
        this.activeVoiceSource.stop();
        this.activeVoiceSource.disconnect();
      } catch {
        // already stopped
      }
      this.activeVoiceSource = null;
    }
    if (this.activeVoiceGain) {
      try {
        this.activeVoiceGain.disconnect();
      } catch {
        // already disconnected
      }
      this.activeVoiceGain = null;
    }
  }

  private activeSfxGains = new Set<GainNode>();

  public stopAllSfxAndVoice(): void {
    this.stopActiveVoice();
    this.stopAiPresenterAudio();
    this.activeSfxSources.forEach((src) => {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // already stopped
      }
    });
    this.activeSfxSources.clear();
    this.activeSfxGains.forEach((g) => {
      try {
        g.gain.cancelScheduledValues(0);
        g.gain.setValueAtTime(0.0001, this.ctx?.currentTime ?? 0);
        g.disconnect();
      } catch {
        // already disconnected
      }
    });
    this.activeSfxGains.clear();
  }

  private mergeDuckIntervals(
    intervals: Array<{ start: number; end: number }>
  ): Array<{ start: number; end: number }> {
    const sorted = [...intervals]
      .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start + 0.05)
      .sort((a, b) => a.start - b.start);
    if (sorted.length === 0) return [];

    const merged: Array<{ start: number; end: number }> = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = sorted[i];
      if (curr.start <= prev.end + 0.18) {
        prev.end = Math.max(prev.end, curr.end);
      } else {
        merged.push({ ...curr });
      }
    }
    return merged;
  }

  private scheduleDuckCurveOnNode(
    gainParam: AudioParam,
    base: number,
    target: number,
    merged: Array<{ start: number; end: number }>,
    ctx: BaseAudioContext,
    audioStartTime: number,
    hardLimit: number
  ): void {
    try {
      gainParam.cancelScheduledValues(audioStartTime);
      gainParam.setValueAtTime(base, audioStartTime);
      let lastScheduledTime = audioStartTime;
      for (const iv of merged) {
        const tStart = Math.max(lastScheduledTime + 0.02, ctx.currentTime, audioStartTime + iv.start);
        if (tStart >= hardLimit - 0.14) break;
        const fadeDownStart = Math.max(lastScheduledTime + 0.005, tStart - 0.04);
        const rampDownAt = Math.max(fadeDownStart + 0.02, tStart + 0.04);
        const rawEnd = Math.max(rampDownAt + 0.04, audioStartTime + iv.end);
        const tEnd = Math.min(hardLimit - 0.05, rawEnd);
        const holdUntil = Math.max(rampDownAt + 0.01, tEnd - 0.03);
        const recoverAt = Math.min(hardLimit, holdUntil + 0.18);
        if (recoverAt <= fadeDownStart + 0.04) break;

        gainParam.setValueAtTime(base, fadeDownStart);
        gainParam.linearRampToValueAtTime(target, rampDownAt);
        gainParam.setValueAtTime(target, holdUntil);
        gainParam.linearRampToValueAtTime(base, recoverAt);
        lastScheduledTime = recoverAt;
      }
    } catch {
      // ignore scheduling errors
    }
  }

  public scheduleBgDuckIntervals(
    ctx: BaseAudioContext,
    intervals: Array<{ start: number; end: number }>,
    audioStartTime: number,
    duckRatio = 0.22,
    maxAbsoluteEnd?: number
  ): void {
    const merged = this.mergeDuckIntervals(intervals);
    if (merged.length === 0) return;
    const hardLimit = maxAbsoluteEnd ?? Infinity;

    const bgEntry = this.bgNodes.get(ctx);
    if (bgEntry && bgEntry.baseVolume > 0.001) {
      const base = bgEntry.baseVolume;
      const target = Math.max(0.01, base * Math.max(0.05, Math.min(0.8, duckRatio)));
      this.scheduleDuckCurveOnNode(
        bgEntry.gain.gain,
        base,
        target,
        merged,
        ctx,
        audioStartTime,
        hardLimit
      );
    }

    const ambEntry = this.ambientNodes.get(ctx);
    if (ambEntry && ambEntry.autoDuck && ambEntry.baseVolume > 0.001) {
      const base = ambEntry.baseVolume;
      const ambDuckRatio = Math.max(0.32, Math.min(0.85, duckRatio + 0.15));
      const target = Math.max(0.01, base * ambDuckRatio);
      this.scheduleDuckCurveOnNode(
        ambEntry.gain.gain,
        base,
        target,
        merged,
        ctx,
        audioStartTime,
        hardLimit
      );
    }
  }

  public duckBgMusic(
    ctxOverride: BaseAudioContext | undefined,
    speechDurationSec: number,
    duckRatio = 0.22
  ): void {
    const ctx = ctxOverride ?? this.ctx;
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur = Math.max(0.35, speechDurationSec);

    const bgEntry = this.bgNodes.get(ctx);
    if (bgEntry && bgEntry.baseVolume > 0.001) {
      const targetGain = Math.max(0.01, bgEntry.baseVolume * Math.max(0.05, Math.min(0.8, duckRatio)));
      const gainParam = bgEntry.gain.gain;
      try {
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(gainParam.value, now);
        gainParam.linearRampToValueAtTime(targetGain, now + 0.08);
        gainParam.setValueAtTime(targetGain, now + Math.max(0.1, dur - 0.05));
        gainParam.linearRampToValueAtTime(bgEntry.baseVolume, now + dur + 0.22);
      } catch {
        // ignore scheduling errors
      }
    }

    const ambEntry = this.ambientNodes.get(ctx);
    if (ambEntry && ambEntry.autoDuck && ambEntry.baseVolume > 0.001) {
      const ambRatio = Math.max(0.32, Math.min(0.85, duckRatio + 0.15));
      const targetGain = Math.max(0.01, ambEntry.baseVolume * ambRatio);
      const gainParam = ambEntry.gain.gain;
      try {
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(gainParam.value, now);
        gainParam.linearRampToValueAtTime(targetGain, now + 0.1);
        gainParam.setValueAtTime(targetGain, now + Math.max(0.1, dur - 0.05));
        gainParam.linearRampToValueAtTime(ambEntry.baseVolume, now + dur + 0.24);
      } catch {
        // ignore scheduling errors
      }
    }
  }

  private getDataUrlKey(dataUrl: string): string {
    return `${dataUrl.slice(0, 64)}:${dataUrl.length}:${dataUrl.slice(-24)}`;
  }

  public getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public async unlock(): Promise<AudioContext> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      await Promise.race([
        ctx.resume().catch(() => undefined),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 250);
        }),
      ]);
    }
    return ctx;
  }

  public async getAudioDuration(dataUrl: string): Promise<number> {
    try {
      const buf = await this.decodeDataUrl(dataUrl);
      if (buf && Number.isFinite(buf.duration) && buf.duration > 0) {
        return buf.duration;
      }
    } catch {
      // fall through to metadata/header fallback
    }

    const metaDuration = await new Promise<number>((resolve) => {
      let settled = false;
      const done = (val: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => done(0), 2500);
      const el = document.createElement('audio');
      el.preload = 'metadata';
      el.onloadedmetadata = () => {
        const dur = Number.isFinite(el.duration) ? el.duration : 0;
        done(dur);
      };
      el.onerror = () => done(0);
      el.src = dataUrl;
    });

    if (metaDuration > 0) return metaDuration;

    if (dataUrl.startsWith('data:audio/wav;base64,')) {
      const base64Len = dataUrl.length - 'data:audio/wav;base64,'.length;
      const byteLen = Math.max(0, Math.floor((base64Len * 3) / 4) - 44);
      if (byteLen > 0) {
        return Math.max(0.5, byteLen / 48000);
      }
    }
    return 0;
  }

  public async decodeDataUrl(
    dataUrl: string,
    targetCtx?: BaseAudioContext
  ): Promise<AudioBuffer | null> {
    const ctx = targetCtx ?? this.getContext();
    const cache = this.getCacheForContext(ctx);
    const cacheKey = this.getDataUrlKey(dataUrl);
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey) ?? null;
    }
    try {
      const response = await fetch(dataUrl);
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
      cache.set(cacheKey, decoded);
      if (Number.isFinite(decoded.duration) && decoded.duration > 0) {
        this.decodedDurations.set(cacheKey, decoded.duration);
      }
      return decoded;
    } catch {
      return null;
    }
  }

  public getExactDuration(dataUrl: string | undefined, fallback: number): number {
    if (!dataUrl) return fallback;
    const d = this.decodedDurations.get(this.getDataUrlKey(dataUrl));
    return d && Number.isFinite(d) && d > 0 ? d : fallback;
  }

  public async preloadAllAudio(
    audio: AudioSettings,
    slides: QuestionSlide[] = [],
    targetCtx?: BaseAudioContext,
    template?: TemplateSettings
  ): Promise<void> {
    const slots: AudioSlotId[] = [
      'questionEnter',
      'optionEnter',
      'countdownTick',
      'suspense',
      'correctReveal',
      'bgMusic',
    ];
    const tasks: Promise<unknown>[] = slots.map(async (slot) => {
      const cfg = audio[slot];
      if (cfg && cfg.sourceType === 'custom' && cfg.customDataUrl) {
        await this.decodeDataUrl(cfg.customDataUrl, targetCtx);
      }
    });

    if (audio.ambient?.sourceType === 'custom' && audio.ambient.customDataUrl) {
      tasks.push(this.decodeDataUrl(audio.ambient.customDataUrl, targetCtx));
    }

    if (template?.introHookAudio?.dataUrl) {
      tasks.push(this.decodeDataUrl(template.introHookAudio.dataUrl, targetCtx));
    }
    if (template?.endCardAudio?.dataUrl) {
      tasks.push(this.decodeDataUrl(template.endCardAudio.dataUrl, targetCtx));
    }

    for (const slide of slides) {
      if (slide.voiceover?.question?.dataUrl) {
        tasks.push(this.decodeDataUrl(slide.voiceover.question.dataUrl, targetCtx));
      }
      if (slide.voiceover?.answer?.dataUrl) {
        tasks.push(this.decodeDataUrl(slide.voiceover.answer.dataUrl, targetCtx));
      }
      if (slide.voiceover?.explanation?.dataUrl) {
        tasks.push(this.decodeDataUrl(slide.voiceover.explanation.dataUrl, targetCtx));
      }
      slide.voiceover?.options?.forEach((clip) => {
        if (clip?.dataUrl) {
          tasks.push(this.decodeDataUrl(clip.dataUrl, targetCtx));
        }
      });
    }

    await Promise.all(tasks);
  }

  public async syncProjectAudioDurations(
    slides: QuestionSlide[],
    audio: AudioSettings,
    template: TemplateSettings,
    targetCtx?: BaseAudioContext
  ): Promise<{ slides: QuestionSlide[]; audio: AudioSettings; template: TemplateSettings }> {
    await this.preloadAllAudio(audio, slides, targetCtx, template);

    const syncClip = (clip?: SlideAudioClip): SlideAudioClip | undefined => {
      if (!clip?.dataUrl) return clip;
      const exact = this.getExactDuration(clip.dataUrl, clip.duration);
      return Math.abs(exact - clip.duration) > 0.01 ? { ...clip, duration: exact } : clip;
    };

    const syncedSlides: QuestionSlide[] = slides.map((s) => {
      if (!s.voiceover) return s;
      const q = syncClip(s.voiceover.question);
      const ans = syncClip(s.voiceover.answer);
      const exp = syncClip(s.voiceover.explanation);
      const opts = s.voiceover.options
        ? ([
            syncClip(s.voiceover.options[0]),
            syncClip(s.voiceover.options[1]),
            syncClip(s.voiceover.options[2]),
            syncClip(s.voiceover.options[3]),
          ] as [
            SlideAudioClip | undefined,
            SlideAudioClip | undefined,
            SlideAudioClip | undefined,
            SlideAudioClip | undefined
          ])
        : undefined;
      return {
        ...s,
        voiceover: {
          ...s.voiceover,
          question: q,
          answer: ans,
          explanation: exp,
          options: opts,
        },
      };
    });

    const syncSlot = (cfg: AudioSlotConfig): AudioSlotConfig => {
      if (cfg.sourceType !== 'custom' || !cfg.customDataUrl) return cfg;
      const exact = this.getExactDuration(cfg.customDataUrl, cfg.duration ?? 0);
      return exact > 0 ? { ...cfg, duration: exact } : cfg;
    };

    const syncedAudio: AudioSettings = {
      questionEnter: syncSlot(audio.questionEnter),
      optionEnter: syncSlot(audio.optionEnter),
      countdownTick: syncSlot(audio.countdownTick),
      suspense: syncSlot(audio.suspense),
      correctReveal: syncSlot(audio.correctReveal),
      bgMusic: syncSlot(audio.bgMusic),
      ambient:
        audio.ambient?.sourceType === 'custom' && audio.ambient.customDataUrl
          ? {
              ...audio.ambient,
              duration:
                this.getExactDuration(audio.ambient.customDataUrl, audio.ambient.duration ?? 0) ||
                audio.ambient.duration,
            }
          : audio.ambient,
    };

    const syncedTemplate: TemplateSettings =
      template.introHookAudio?.dataUrl || template.endCardAudio?.dataUrl
        ? {
            ...template,
            ...(template.introHookAudio?.dataUrl
              ? { introHookAudio: syncClip(template.introHookAudio) }
              : {}),
            ...(template.endCardAudio?.dataUrl
              ? { endCardAudio: syncClip(template.endCardAudio) }
              : {}),
          }
        : template;

    return {
      slides: syncedSlides,
      audio: syncedAudio,
      template: syncedTemplate,
    };
  }

  private scheduleBufferWithEnvelope(
    ctx: BaseAudioContext,
    buffer: AudioBuffer,
    volume: number,
    destination: AudioNode,
    startTime: number,
    maxEndTime?: number,
    trackChannel?: 'sfx' | 'voice' | 'aiPresenter'
  ): void {
    const start = Math.max(ctx.currentTime, startTime);
    const naturalEnd = start + buffer.duration;
    const clampedEnd =
      maxEndTime !== undefined ? Math.min(naturalEnd, Math.max(start + 0.03, maxEndTime)) : naturalEnd;
    if (clampedEnd <= start + 0.015) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, start);

      // Smooth micro fade-out when truncated before buffer's natural end so clicks/bleed never occur
      if (maxEndTime !== undefined && clampedEnd < naturalEnd - 0.01) {
        const fadeDur = Math.min(0.035, (clampedEnd - start) * 0.4);
        const fadeStart = Math.max(start, clampedEnd - fadeDur);
        gain.gain.setValueAtTime(volume, fadeStart);
        gain.gain.linearRampToValueAtTime(0.0001, clampedEnd);
      }

      src.connect(gain);
      if (ctx === this.ctx && (trackChannel === 'voice' || trackChannel === 'aiPresenter') && destination === ctx.destination) {
        if (!this.voiceAnalyser) {
          this.voiceAnalyser = ctx.createAnalyser();
          this.voiceAnalyser.fftSize = 128;
          this.voiceAnalyser.smoothingTimeConstant = 0.6;
          this.voiceAnalyser.connect(ctx.destination);
        }
        gain.connect(this.voiceAnalyser);
      } else {
        gain.connect(destination);
      }
      if (trackChannel) {
        this.trackSourceIfPreview(ctx, src, trackChannel, gain);
      }
      src.start(start);
      if (clampedEnd < naturalEnd + 0.02) {
        src.stop(clampedEnd + 0.005);
      }
    } catch {
      // ignore invalid scheduling window
    }
  }

  public async playClip(
    clip: SlideAudioClip,
    volume = 1,
    destination?: AudioNode,
    ctxOverride?: BaseAudioContext,
    when?: number,
    channel: 'voice' | 'sfx' | 'aiPresenter' = 'voice',
    maxDurationSec?: number
  ): Promise<void> {
    if (volume <= 0.001 || !clip.dataUrl) return;
    const ctx = ctxOverride ?? this.getContext();
    const dest = destination ?? ctx.destination;
    const cache = this.getCacheForContext(ctx);
    const cached = cache.get(this.getDataUrlKey(clip.dataUrl));
    const buffer = cached ?? (await this.decodeDataUrl(clip.dataUrl, ctx));
    if (!buffer) return;

    const startTime = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    const maxEnd = maxDurationSec !== undefined ? startTime + maxDurationSec : undefined;
    this.scheduleBufferWithEnvelope(ctx, buffer, volume, dest, startTime, maxEnd, channel);
  }

  public playBufferSlice(
    buffer: AudioBuffer,
    volume: number,
    offsetSec: number,
    durationSec: number,
    destination?: AudioNode,
    ctxOverride?: BaseAudioContext,
    when?: number,
    channel: 'voice' | 'sfx' | 'aiPresenter' = 'voice'
  ): AudioBufferSourceNode | null {
    if (volume <= 0.001 || durationSec <= 0.03) return null;
    const ctx = ctxOverride ?? this.getContext();
    const dest = destination ?? ctx.destination;
    const start = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    const safeOffset = Math.max(0, Math.min(Math.max(0, buffer.duration - 0.04), offsetSec));
    const safeDur = Math.max(0.03, Math.min(durationSec, buffer.duration - safeOffset));
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, start);
      const fadeDur = Math.min(0.035, safeDur * 0.25);
      gain.gain.setValueAtTime(volume, Math.max(start, start + safeDur - fadeDur));
      gain.gain.linearRampToValueAtTime(0.0001, start + safeDur);
      src.connect(gain);
      if (ctx === this.ctx && (channel === 'voice' || channel === 'aiPresenter') && dest === ctx.destination) {
        if (!this.voiceAnalyser) {
          this.voiceAnalyser = ctx.createAnalyser();
          this.voiceAnalyser.fftSize = 128;
          this.voiceAnalyser.smoothingTimeConstant = 0.6;
          this.voiceAnalyser.connect(ctx.destination);
        }
        gain.connect(this.voiceAnalyser);
      } else {
        gain.connect(dest);
      }
      if (channel) {
        this.trackSourceIfPreview(ctx, src, channel, gain);
      }
      src.start(start, safeOffset, safeDur);
      src.stop(start + safeDur + 0.01);
      return src;
    } catch {
      return null;
    }
  }

  public async playSlot(
    config: AudioSlotConfig,
    destination?: AudioNode,
    ctxOverride?: BaseAudioContext,
    when?: number,
    urgent = false,
    maxDurationSec?: number,
    suspenseDurationSec?: number
  ): Promise<void> {
    if (!config || config.volume <= 0.001) return;
    const ctx = ctxOverride ?? this.getContext();
    const dest = destination ?? ctx.destination;

    if (config.sourceType === 'custom' && config.customDataUrl) {
      const cache = this.getCacheForContext(ctx);
      const cached = cache.get(this.getDataUrlKey(config.customDataUrl));
      const buffer = cached ?? (await this.decodeDataUrl(config.customDataUrl, ctx));
      if (buffer) {
        const startTime = Math.max(ctx.currentTime, when ?? ctx.currentTime);
        const maxEnd = maxDurationSec !== undefined ? startTime + maxDurationSec : undefined;
        this.scheduleBufferWithEnvelope(ctx, buffer, config.volume, dest, startTime, maxEnd, 'sfx');
        return;
      }
    }

    const startTime = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    this.playBuiltInSfx(
      config.builtinId,
      config.volume,
      ctx,
      dest,
      startTime,
      urgent,
      suspenseDurationSec,
      maxDurationSec
    );
  }

  public async startBgMusic(
    config: AudioSlotConfig,
    destination?: AudioNode,
    ctxOverride?: BaseAudioContext
  ): Promise<AudioBufferSourceNode | null> {
    this.stopBgMusic();
    if (!config || config.volume <= 0.001) return null;
    if (config.sourceType !== 'custom' || !config.customDataUrl) {
      return null;
    }

    const ctx = ctxOverride ?? this.getContext();
    const dest = destination ?? ctx.destination;
    const buffer = await this.decodeDataUrl(config.customDataUrl, ctx);
    if (!buffer) return null;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(config.volume, ctx.currentTime);
    src.connect(gain);
    gain.connect(dest);
    src.start(ctx.currentTime);

    this.bgNodes.set(ctx, { gain, baseVolume: config.volume });

    if (!ctxOverride) {
      this.activeBgSource = src;
      this.activeBgGain = gain;
    }
    return src;
  }

  public stopBgMusic(): void {
    if (this.ctx) {
      this.bgNodes.delete(this.ctx);
    }
    if (this.activeBgSource) {
      try {
        this.activeBgSource.stop();
        this.activeBgSource.disconnect();
      } catch {
        // already stopped
      }
      this.activeBgSource = null;
    }
    if (this.activeBgGain) {
      this.activeBgGain.disconnect();
      this.activeBgGain = null;
    }
  }

  public getOrCreateAmbientBuffer(id: AmbientSoundId, ctx: BaseAudioContext): AudioBuffer | null {
    if (!id || id === 'none') return null;
    const cache = this.getCacheForContext(ctx);
    const cacheKey = `ambient_loop_v1_${id}_${ctx.sampleRate}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;

    const sr = ctx.sampleRate;
    const loopDurSec = 5.0;
    const xfadeSec = 0.5;
    const loopFrames = Math.floor(sr * loopDurSec);
    const xfadeFrames = Math.floor(sr * xfadeSec);
    const totalFrames = loopFrames + xfadeFrames;

    const rawL = new Float32Array(totalFrames);
    const rawR = new Float32Array(totalFrames);

    // Seed deterministic PRNG per preset id
    let seed = 2166136261;
    for (let i = 0; i < id.length; i++) {
      seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
    }
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randBipolar = () => rand() * 2 - 1;

    // Pink noise filter state for L/R
    let b0L = 0, b1L = 0, b2L = 0, b3L = 0;
    let b0R = 0, b1R = 0, b2R = 0, b3R = 0;
    let lpL = 0, lpR = 0;
    let bpL1 = 0, bpL2 = 0, bpR1 = 0, bpR2 = 0;

    // Discrete stochastic grain events (droplets, fire crackles, artisan taps, bird chirps)
    interface GrainEvent {
      start: number;
      len: number;
      freq: number;
      freqEnd: number;
      ampL: number;
      ampR: number;
      kind: 'ping' | 'pop' | 'step' | 'chirp';
    }
    const grains: GrainEvent[] = [];

    if (id === 'gentleRain') {
      for (let k = 0; k < 58; k++) {
        const pan = rand();
        const amp = 0.03 + rand() * 0.06;
        grains.push({
          start: Math.floor(rand() * (totalFrames - 2000)),
          len: Math.floor(sr * (0.015 + rand() * 0.025)),
          freq: 1400 + rand() * 2400,
          freqEnd: 900 + rand() * 800,
          ampL: amp * (1 - pan * 0.6),
          ampR: amp * (0.4 + pan * 0.6),
          kind: 'ping',
        });
      }
    } else if (id === 'cracklingFire') {
      for (let k = 0; k < 72; k++) {
        const pan = rand();
        const amp = 0.06 + rand() * 0.14;
        grains.push({
          start: Math.floor(rand() * (totalFrames - 1800)),
          len: Math.floor(sr * (0.008 + rand() * 0.024)),
          freq: 1600 + rand() * 3400,
          freqEnd: 700 + rand() * 900,
          ampL: amp * (1 - pan * 0.7),
          ampR: amp * (0.3 + pan * 0.7),
          kind: 'pop',
        });
      }
    } else if (id === 'oldSouk') {
      // Soft distant souk wooden cart/artisan clinks & basket rustle
      for (let k = 0; k < 14; k++) {
        const pan = rand();
        const amp = 0.035 + rand() * 0.045;
        grains.push({
          start: Math.floor(rand() * (totalFrames - 4000)),
          len: Math.floor(sr * (0.045 + rand() * 0.06)),
          freq: 520 + rand() * 680,
          freqEnd: 420 + rand() * 300,
          ampL: amp * (1 - pan * 0.65),
          ampR: amp * (0.35 + pan * 0.65),
          kind: 'ping',
        });
      }
    } else if (id === 'caravanJourney') {
      // 7 steady desert hoof/sand steps across 5.5s
      const stepCount = 8;
      for (let k = 0; k < stepCount; k++) {
        const stepPos = Math.floor((k / stepCount) * totalFrames + (rand() - 0.5) * sr * 0.06);
        if (stepPos >= 0 && stepPos < totalFrames - Math.floor(sr * 0.2)) {
          grains.push({
            start: stepPos,
            len: Math.floor(sr * 0.13),
            freq: 110 + rand() * 28,
            freqEnd: 58,
            ampL: k % 2 === 0 ? 0.16 : 0.11,
            ampR: k % 2 === 0 ? 0.11 : 0.16,
            kind: 'step',
          });
        }
      }
    } else if (id === 'forestBirds') {
      // 6 gentle melodic bird calls
      const birdFreqs = [2250, 2680, 3020, 2480];
      for (let k = 0; k < 6; k++) {
        const pan = rand();
        const f0 = birdFreqs[k % birdFreqs.length] + rand() * 260;
        grains.push({
          start: Math.floor((k * 0.78 + 0.18 + rand() * 0.25) * sr),
          len: Math.floor(sr * (0.14 + rand() * 0.08)),
          freq: f0,
          freqEnd: f0 * (rand() > 0.5 ? 1.18 : 0.84),
          ampL: 0.045 * (1 - pan * 0.65),
          ampR: 0.045 * (0.35 + pan * 0.65),
          kind: 'chirp',
        });
      }
    }

    const TWO_PI = Math.PI * 2;
    for (let i = 0; i < totalFrames; i++) {
      const t = i / sr;
      const wL = randBipolar();
      const wR = randBipolar();

      // Pink noise approx (Paul Kellet)
      b0L = 0.99765 * b0L + wL * 0.099046;
      b1L = 0.963 * b1L + wL * 0.2965164;
      b2L = 0.57 * b2L + wL * 1.0526913;
      const pinkL = (b0L + b1L + b2L + wL * 0.1848) * 0.16;
      b3L = pinkL;

      b0R = 0.99765 * b0R + wR * 0.099046;
      b1R = 0.963 * b1R + wR * 0.2965164;
      b2R = 0.57 * b2R + wR * 1.0526913;
      const pinkR = (b0R + b1R + b2R + wR * 0.1848) * 0.16;
      b3R = pinkR;

      let outL = 0;
      let outR = 0;

      if (id === 'spiritualPad') {
        // Warm, serene harmonic chord (D3=146.8, A3=220, D4=293.6, A4=440 integer-friendly harmonics)
        const breath = 0.82 + 0.18 * Math.sin(TWO_PI * (t / loopDurSec));
        const d3 = Math.sin(TWO_PI * 147 * t) * 0.24;
        const a3 = Math.sin(TWO_PI * 220.5 * t + 0.4) * 0.16;
        const d4 = Math.sin(TWO_PI * 294 * t + 1.1) * 0.09;
        const f4 = Math.sin(TWO_PI * 367.5 * t + 0.7) * 0.04;
        lpL = lpL * 0.94 + pinkL * 0.06;
        lpR = lpR * 0.94 + pinkR * 0.06;
        outL = (d3 + a3 * 0.9 + d4 + f4) * 0.48 * breath + lpL * 0.16;
        outR = (d3 + a3 * 1.05 + d4 * 0.9 + f4 * 1.1) * 0.48 * breath + lpR * 0.16;
      } else if (id === 'documentaryDepth') {
        const swell = 0.78 + 0.22 * Math.sin(TWO_PI * (t / loopDurSec) + 0.8);
        const sub = Math.sin(TWO_PI * 65.4 * t) * 0.28 + Math.sin(TWO_PI * 98 * t) * 0.16;
        const mid = Math.sin(TWO_PI * 130.8 * t + 0.5) * 0.1 + Math.sin(TWO_PI * 196 * t) * 0.05;
        lpL = lpL * 0.92 + pinkL * 0.08;
        lpR = lpR * 0.92 + pinkR * 0.08;
        outL = (sub + mid) * 0.55 * swell + lpL * 0.25;
        outR = (sub + mid * 0.94) * 0.55 * swell + lpR * 0.25;
      } else if (id === 'desertWind' || id === 'caravanJourney') {
        const gustL = 0.55 + 0.45 * Math.sin(TWO_PI * 0.4 * t + 0.2);
        const gustR = 0.55 + 0.45 * Math.sin(TWO_PI * 0.4 * t + 1.4);
        const cut = 0.05 + 0.07 * (0.5 + 0.5 * Math.sin(TWO_PI * 0.2 * t));
        lpL = lpL + cut * (pinkL - lpL);
        lpR = lpR + cut * (pinkR - lpR);
        bpL1 = bpL1 + 0.025 * (lpL - bpL1);
        bpR1 = bpR1 + 0.025 * (lpR - bpR1);
        outL = (lpL - bpL1 * 0.75) * 1.15 * gustL;
        outR = (lpR - bpR1 * 0.75) * 1.15 * gustR;
      } else if (id === 'gentleRain') {
        lpL = lpL * 0.68 + pinkL * 0.32;
        lpR = lpR * 0.68 + pinkR * 0.32;
        const steady = 0.92 + 0.08 * Math.sin(TWO_PI * 0.6 * t);
        outL = lpL * 1.05 * steady + (pinkL - lpL) * 0.28;
        outR = lpR * 1.05 * steady + (pinkR - lpR) * 0.28;
      } else if (id === 'oceanWaves') {
        // 5-second rhythmic ocean wave surge
        const phase = (t % loopDurSec) / loopDurSec;
        const wave = Math.pow(0.5 - 0.5 * Math.cos(TWO_PI * phase), 1.4);
        const coeff = 0.04 + wave * 0.22;
        lpL = lpL + coeff * (pinkL - lpL);
        lpR = lpR + coeff * (pinkR - lpR);
        const foam = (pinkL - lpL) * wave * 0.32;
        const foamR = (pinkR - lpR) * wave * 0.32;
        outL = lpL * (0.45 + 1.25 * wave) + foam;
        outR = lpR * (0.45 + 1.25 * wave) + foamR;
      } else if (id === 'nightCrickets') {
        // Cool nocturnal breeze + gentle pulsed crickets
        lpL = lpL * 0.91 + pinkL * 0.09;
        lpR = lpR * 0.91 + pinkR * 0.09;
        const cycle = (t * 1.2) % 1;
        const burstEnv =
          cycle < 0.36 ? Math.max(0, Math.sin(TWO_PI * 14 * cycle)) * Math.sin((Math.PI * cycle) / 0.36) : 0;
        const c1 = Math.sin(TWO_PI * 4120 * t) * 0.048 * burstEnv;
        const cycle2 = ((t + 0.42) * 1.0) % 1;
        const burstEnv2 =
          cycle2 < 0.3 ? Math.max(0, Math.sin(TWO_PI * 12 * cycle2)) * Math.sin((Math.PI * cycle2) / 0.3) : 0;
        const c2 = Math.sin(TWO_PI * 4380 * t) * 0.036 * burstEnv2;
        outL = lpL * 0.62 + c1 * 0.8 + c2 * 0.35;
        outR = lpR * 0.62 + c1 * 0.35 + c2 * 0.85;
      } else if (id === 'forestBirds') {
        const breeze = 0.7 + 0.3 * Math.sin(TWO_PI * 0.4 * t);
        lpL = lpL * 0.85 + pinkL * 0.15;
        lpR = lpR * 0.85 + pinkR * 0.15;
        outL = lpL * 0.72 * breeze;
        outR = lpR * 0.72 * breeze;
      } else if (id === 'cracklingFire') {
        lpL = lpL * 0.92 + pinkL * 0.08;
        lpR = lpR * 0.92 + pinkR * 0.08;
        const rumble = 0.85 + 0.15 * Math.sin(TWO_PI * 2.2 * t);
        outL = lpL * 1.15 * rumble;
        outR = lpR * 1.15 * rumble;
      } else if (id === 'oldSouk') {
        // Warm crowd chatter murmur across speech formants (300-1100Hz) + breezy ambiance
        const swellL = 0.7 + 0.3 * Math.sin(TWO_PI * 0.8 * t + 0.3) * Math.sin(TWO_PI * 1.8 * t);
        const swellR = 0.7 + 0.3 * Math.sin(TWO_PI * 0.6 * t + 1.9) * Math.sin(TWO_PI * 2.2 * t);
        lpL = lpL + 0.14 * (pinkL - lpL);
        bpL1 = bpL1 + 0.03 * (lpL - bpL1);
        bpL2 = bpL2 + 0.08 * ((lpL - bpL1) - bpL2);
        lpR = lpR + 0.14 * (pinkR - lpR);
        bpR1 = bpR1 + 0.03 * (lpR - bpR1);
        bpR2 = bpR2 + 0.08 * ((lpR - bpR1) - bpR2);
        outL = lpL * 0.52 + bpL2 * 0.95 * swellL;
        outR = lpR * 0.52 + bpR2 * 0.95 * swellR;
      } else if (id === 'quizCrowd') {
        // Studio crowd murmur + anticipation room tone
        const modL = 0.78 + 0.22 * Math.sin(TWO_PI * 1.2 * t + 0.5);
        const modR = 0.78 + 0.22 * Math.sin(TWO_PI * 1.4 * t + 2.1);
        lpL = lpL + 0.16 * (pinkL - lpL);
        bpL1 = bpL1 + 0.035 * (lpL - bpL1);
        lpR = lpR + 0.16 * (pinkR - lpR);
        bpR1 = bpR1 + 0.035 * (lpR - bpR1);
        const studioHum = Math.sin(TWO_PI * 110 * t) * 0.04;
        outL = (lpL - bpL1 * 0.55) * 0.95 * modL + lpL * 0.35 + studioHum;
        outR = (lpR - bpR1 * 0.55) * 0.95 * modR + lpR * 0.35 + studioHum;
      } else if (id === 'stadiumAmbience') {
        // Wide arena crowd roar + energetic cheering waves
        const cheerWave = 0.74 + 0.26 * Math.sin(TWO_PI * 0.4 * t);
        lpL = lpL + 0.24 * (pinkL - lpL);
        bpL1 = bpL1 + 0.04 * (lpL - bpL1);
        lpR = lpR + 0.24 * (pinkR - lpR);
        bpR1 = bpR1 + 0.04 * (lpR - bpR1);
        outL = ((lpL - bpL1 * 0.4) * 1.1 + pinkL * 0.22) * cheerWave;
        outR = ((lpR - bpR1 * 0.4) * 1.1 + pinkR * 0.22) * cheerWave;
      }

      rawL[i] = outL;
      rawR[i] = outR;
      void b3L;
      void b3R;
    }

    // Mix discrete stochastic grains
    for (const g of grains) {
      for (let j = 0; j < g.len; j++) {
        const idx = g.start + j;
        if (idx >= totalFrames) break;
        const p = j / Math.max(1, g.len);
        const env =
          g.kind === 'chirp'
            ? Math.sin(Math.PI * p) * Math.sin(Math.PI * Math.min(1, p * 3))
            : Math.exp(-p * (g.kind === 'pop' ? 7.5 : g.kind === 'step' ? 4.2 : 5.5)) *
              Math.min(1, p * 12);
        const freq = g.freq + (g.freqEnd - g.freq) * p;
        const sig =
          g.kind === 'pop'
            ? (Math.sin(TWO_PI * freq * (j / sr)) * 0.6 + randBipolar() * 0.4) * env
            : g.kind === 'step'
              ? (Math.sin(TWO_PI * freq * (j / sr)) * 0.75 + randBipolar() * 0.18) * env
              : Math.sin(TWO_PI * freq * (j / sr)) * env;
        rawL[idx] += sig * g.ampL;
        rawR[idx] += sig * g.ampR;
      }
    }

    // Overlap-add raised-cosine seamless loop crossfade so loop seam is 100% invisible
    const buf = ctx.createBuffer(2, loopFrames, sr);
    const outChL = buf.getChannelData(0);
    const outChR = buf.getChannelData(1);

    for (let i = 0; i < loopFrames; i++) {
      let sL = rawL[i];
      let sR = rawR[i];
      if (i < xfadeFrames) {
        const alpha = 0.5 * (1 - Math.cos(Math.PI * (i / xfadeFrames)));
        sL = sL * alpha + rawL[loopFrames + i] * (1 - alpha);
        sR = sR * alpha + rawR[loopFrames + i] * (1 - alpha);
      }
      outChL[i] = Math.max(-0.92, Math.min(0.92, sL));
      outChR[i] = Math.max(-0.92, Math.min(0.92, sR));
    }

    cache.set(cacheKey, buf);
    return buf;
  }

  public async startAmbientSound(
    config: AmbientSoundConfig | undefined,
    destination?: AudioNode,
    ctxOverride?: BaseAudioContext
  ): Promise<AudioBufferSourceNode | null> {
    if (!ctxOverride) {
      this.stopAmbientSound();
    }
    if (!config || config.volume <= 0.001) return null;

    const ctx = ctxOverride ?? this.getContext();
    const dest = destination ?? ctx.destination;
    let buffer: AudioBuffer | null = null;

    if (config.sourceType === 'custom' && config.customDataUrl) {
      buffer = await this.decodeDataUrl(config.customDataUrl, ctx);
    } else if (config.id && config.id !== 'none') {
      buffer = this.getOrCreateAmbientBuffer(config.id, ctx);
    }

    if (!buffer) return null;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(config.volume, Math.min(ctx.currentTime + 0.25, ctx.currentTime + 0.25));
    src.connect(gain);
    gain.connect(dest);
    src.start(ctx.currentTime);

    this.ambientNodes.set(ctx, {
      gain,
      baseVolume: config.volume,
      autoDuck: config.autoDuck !== false,
    });

    if (!ctxOverride) {
      this.activeAmbientSource = src;
      this.activeAmbientGain = gain;
    }
    return src;
  }

  public stopAmbientSound(): void {
    if (this.ctx) {
      this.ambientNodes.delete(this.ctx);
    }
    if (this.activeAmbientSource) {
      try {
        this.activeAmbientSource.stop();
        this.activeAmbientSource.disconnect();
      } catch {
        // already stopped
      }
      this.activeAmbientSource = null;
    }
    if (this.activeAmbientGain) {
      try {
        this.activeAmbientGain.disconnect();
      } catch {
        // already disconnected
      }
      this.activeAmbientGain = null;
    }
  }

  public async previewAmbientSound(config: AmbientSoundConfig): Promise<void> {
    await this.unlock();
    if (config.sourceType !== 'custom' && config.id === 'none') {
      this.stopAmbientSound();
      return;
    }
    await this.startAmbientSound(config);
  }

  public previewBuiltInSfx(id: BuiltInSfxId, volume = 0.78): void {
    if (id === 'none') return;
    try {
      const ctx = this.getContext();
      this.stopAllSfxAndVoice();
      this.playBuiltInSfx(id, volume, ctx, ctx.destination, ctx.currentTime, false, 1.4, 1.4);
    } catch {
      // ignore audio unlock errors
    }
  }

  public playBuiltInSfx(
    id: BuiltInSfxId,
    volume: number,
    ctx: BaseAudioContext,
    dest: AudioNode,
    now: number,
    urgent = false,
    suspenseDurationSec = 1.6,
    maxDurationSec?: number
  ): void {
    if (id === 'none' || volume <= 0.001) return;

    // Route through a dedicated envelope gate when bounded OR in preview so nothing bleeds past phase boundary
    let targetDest: AudioNode = dest;
    if (maxDurationSec !== undefined || ctx === this.ctx) {
      const gate = ctx.createGain();
      gate.gain.setValueAtTime(1, now);
      if (maxDurationSec !== undefined && Number.isFinite(maxDurationSec)) {
        const safeMax = Math.max(0.05, maxDurationSec);
        const fadeStart = Math.max(now, now + safeMax - Math.min(0.035, safeMax * 0.3));
        gate.gain.setValueAtTime(1, fadeStart);
        gate.gain.linearRampToValueAtTime(0.0001, now + safeMax);
      }
      gate.connect(dest);
      targetDest = gate;
      if (ctx === this.ctx) {
        this.activeSfxGains.add(gate);
        window.setTimeout(() => {
          this.activeSfxGains.delete(gate);
          try {
            gate.disconnect();
          } catch {
            // ignore
          }
        }, Math.ceil((maxDurationSec ?? 1.8) * 1000) + 120);
      }
    }

    switch (id) {
      case 'softPop': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(860, now + 0.12);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(volume * 0.36, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.connect(gain);
        gain.connect(targetDest);
        osc.start(now);
        osc.stop(now + 0.16);
        break;
      }

      case 'click': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(920, now);
        osc.frequency.exponentialRampToValueAtTime(340, now + 0.045);
        gain.gain.setValueAtTime(volume * 0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.connect(gain);
        gain.connect(targetDest);
        osc.start(now);
        osc.stop(now + 0.07);
        break;
      }

      case 'channelTick': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(urgent ? 1500 : 1000, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(volume * 0.18, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
        osc.connect(gain);
        gain.connect(targetDest);
        osc.start(now);
        osc.stop(now + 0.085);
        break;
      }

      case 'tick': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(urgent ? 1350 : 1150, now);
        osc.frequency.exponentialRampToValueAtTime(750, now + 0.03);
        gain.gain.setValueAtTime(volume * 0.32, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
        osc.connect(gain);
        gain.connect(targetDest);
        osc.start(now);
        osc.stop(now + 0.055);
        break;
      }

      case 'suspenseRiser': {
        const susDur = Math.max(0.35, Math.min(4.0, suspenseDurationSec || 1.6));
        const endT = now + Math.max(0.28, susDur - 0.04);
        const riser = ctx.createOscillator();
        const riserGain = ctx.createGain();
        riser.type = 'sawtooth';
        riser.frequency.setValueAtTime(180, now);
        riser.frequency.exponentialRampToValueAtTime(900, endT);
        riserGain.gain.setValueAtTime(0.0001, now);
        riserGain.gain.exponentialRampToValueAtTime(volume * 0.16, now + 0.04);
        riserGain.gain.setValueAtTime(volume * 0.14, Math.max(now + 0.06, endT - 0.08));
        riserGain.gain.exponentialRampToValueAtTime(0.0001, endT);
        riser.connect(riserGain);
        riserGain.connect(targetDest);
        riser.start(now);
        riser.stop(endT + 0.02);

        const pulseCount = Math.max(2, Math.floor((susDur - 0.08) / 0.25));
        for (let k = 0; k < pulseCount; k++) {
          const t = now + k * 0.25;
          if (t + 0.17 > endT) break;
          const thump = ctx.createOscillator();
          const thumpGain = ctx.createGain();
          thump.type = 'sine';
          thump.frequency.setValueAtTime(90, t);
          thumpGain.gain.setValueAtTime(0.0001, t);
          thumpGain.gain.exponentialRampToValueAtTime(volume * 0.42, t + 0.015);
          thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
          thump.connect(thumpGain);
          thumpGain.connect(targetDest);
          thump.start(t);
          thump.stop(t + 0.17);
        }
        break;
      }

      case 'whoosh': {
        const bufferSize = Math.floor(ctx.sampleRate * 0.28);
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.setValueAtTime(2.2, now);
        filter.frequency.setValueAtTime(260, now);
        filter.frequency.exponentialRampToValueAtTime(2200, now + 0.18);
        filter.frequency.exponentialRampToValueAtTime(480, now + 0.28);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(volume * 0.45, now + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(targetDest);
        noise.start(now);
        noise.stop(now + 0.29);
        break;
      }

      case 'chime': {
        const freqs = [523.25, 659.25];
        freqs.forEach((f, idx) => {
          const t = now + idx * 0.09;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, t);
          gain.gain.setValueAtTime(0.001, t);
          gain.gain.linearRampToValueAtTime(volume * 0.35, t + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
          osc.connect(gain);
          gain.connect(targetDest);
          osc.start(t);
          osc.stop(t + 0.4);
        });
        break;
      }

      case 'successFanfare': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
          const t = now + idx * 0.1;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.001, t);
          gain.gain.linearRampToValueAtTime(volume * 0.32, t + 0.018);
          gain.gain.exponentialRampToValueAtTime(0.001, t + (idx === 3 ? 0.55 : 0.38));
          osc.connect(gain);
          gain.connect(targetDest);
          osc.start(t);
          osc.stop(t + 0.58);
        });
        break;
      }

      case 'calmPulse': {
        const freqs = [293.66, 440];
        freqs.forEach((f) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, now);
          gain.gain.setValueAtTime(0.001, now);
          gain.gain.linearRampToValueAtTime(volume * 0.2, now + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
          osc.connect(gain);
          gain.connect(targetDest);
          osc.start(now);
          osc.stop(now + 0.48);
        });
        break;
      }

      case 'impactBoom': {
        const sub = ctx.createOscillator();
        const subGain = ctx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(145, now);
        sub.frequency.exponentialRampToValueAtTime(38, now + 0.44);
        subGain.gain.setValueAtTime(0.001, now);
        subGain.gain.linearRampToValueAtTime(volume * 0.62, now + 0.015);
        subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
        sub.connect(subGain);
        subGain.connect(targetDest);
        sub.start(now);
        sub.stop(now + 0.54);

        const bufLen = Math.floor(ctx.sampleRate * 0.14);
        const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufLen * 0.35));
        }
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuf;
        const lpf = ctx.createBiquadFilter();
        lpf.type = 'lowpass';
        lpf.frequency.setValueAtTime(1100, now);
        lpf.frequency.exponentialRampToValueAtTime(180, now + 0.14);
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(volume * 0.42, now);
        nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
        noise.connect(lpf);
        lpf.connect(nGain);
        nGain.connect(targetDest);
        noise.start(now);
        noise.stop(now + 0.15);
        break;
      }

      case 'countdownAlarm': {
        [0, 0.14].forEach((offset, idx) => {
          const t = now + offset;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(idx === 0 ? 960 : 1320, t);
          osc.frequency.exponentialRampToValueAtTime(idx === 0 ? 1120 : 1560, t + 0.09);
          gain.gain.setValueAtTime(0.001, t);
          gain.gain.linearRampToValueAtTime(volume * 0.34, t + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
          osc.connect(gain);
          gain.connect(targetDest);
          osc.start(t);
          osc.stop(t + 0.13);
        });
        break;
      }

      case 'mysterySparkle': {
        const notes = [659.25, 880, 1174.66, 1567.98];
        notes.forEach((freq, idx) => {
          const t = now + idx * 0.065;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.001, t);
          gain.gain.linearRampToValueAtTime(volume * 0.24, t + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
          osc.connect(gain);
          gain.connect(targetDest);
          osc.start(t);
          osc.stop(t + 0.36);
        });
        break;
      }

      case 'arcadeLevelUp': {
        const notes = [440, 554.37, 659.25, 880];
        notes.forEach((freq, idx) => {
          const t = now + idx * 0.065;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = idx === notes.length - 1 ? 'triangle' : 'square';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.001, t);
          gain.gain.linearRampToValueAtTime(volume * (idx === notes.length - 1 ? 0.32 : 0.18), t + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + (idx === notes.length - 1 ? 0.28 : 0.11));
          osc.connect(gain);
          gain.connect(targetDest);
          osc.start(t);
          osc.stop(t + 0.3);
        });
        break;
      }

      case 'glitchSnap': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(1750, now);
        osc.frequency.exponentialRampToValueAtTime(240, now + 0.075);
        osc.frequency.setValueAtTime(980, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.16);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(volume * 0.28, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        osc.connect(gain);
        gain.connect(targetDest);
        osc.start(now);
        osc.stop(now + 0.2);
        break;
      }
    }
  }

  /**
   * Sample-accurate offline mixdown for video export.
   * Eliminates timer drift and prevents voiceovers, countdown ticks, suspense,
   * reveal chimes, and background music from colliding or bleeding across phases.
   */
  public async renderOfflineExportMix(
    slides: QuestionSlide[],
    template: TemplateSettings,
    timing: TimingSettings,
    audio: AudioSettings,
    sampleRate = 48000
  ): Promise<RenderedExportAudio | null> {
    if (typeof OfflineAudioContext === 'undefined') {
      return null;
    }

    const totalDuration = Math.max(0.5, getTotalDuration(slides, timing, audio, template));
    let offline: OfflineAudioContext;
    try {
      const totalSamples = Math.ceil((totalDuration + 0.15) * sampleRate);
      offline = new OfflineAudioContext(2, totalSamples, sampleRate);
    } catch {
      const fallbackRate = 44100;
      const totalSamples = Math.ceil((totalDuration + 0.15) * fallbackRate);
      offline = new OfflineAudioContext(2, totalSamples, fallbackRate);
    }

    // Master Limiter prevents transient summing distortion when SFX + music coincide
    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.setValueAtTime(-3, 0);
    limiter.knee.setValueAtTime(6, 0);
    limiter.ratio.setValueAtTime(8, 0);
    limiter.attack.setValueAtTime(0.003, 0);
    limiter.release.setValueAtTime(0.12, 0);
    limiter.connect(offline.destination);

    // Decode all custom clips directly inside OfflineAudioContext (auto-resamples cleanly)
    await this.preloadAllAudio(audio, slides, offline, template);
    const cache = this.getCacheForContext(offline);
    const lookupBuf = (dataUrl?: string): AudioBuffer | null => {
      if (!dataUrl) return null;
      return cache.get(this.getDataUrlKey(dataUrl)) ?? null;
    };

    const schedules = computeProjectTimeline(slides, timing, audio, template);
    const voiceQueue: ScheduledVoiceItem[] = [];
    const speechIntervals: Array<{ start: number; end: number }> = [];

    const introDur = getIntroHookDuration(template, timing);
    if (introDur > 0 && slides.length > 0) {
      const endBound = Math.min(totalDuration, schedules[0]?.startTime ?? introDur);
      const hookSfx = template.introHookSfx ?? 'whoosh';
      const hookBuf = lookupBuf(template.introHookAudio?.dataUrl);
      if (hookSfx && hookSfx !== 'none' && !hookBuf) {
        this.playBuiltInSfx(
          hookSfx,
          0.72,
          offline,
          limiter,
          0,
          false,
          1.6,
          Math.max(0.15, endBound - 0.02)
        );
      }
      if (hookBuf) {
        if (hookSfx && hookSfx !== 'none') {
          this.playBuiltInSfx(hookSfx, 0.42, offline, limiter, 0, false, 1.6, Math.min(0.28, endBound - 0.02));
        }
        voiceQueue.push({
          start: 0,
          buffer: hookBuf,
          volume: 1,
          maxEnd: endBound - 0.02,
        });
      }
    }

    const urgentThreshold = Math.max(1, Math.min(10, template?.timerUrgentThreshold ?? 3));

    for (let idx = 0; idx < schedules.length; idx++) {
      const sched = schedules[idx];
      const slide = slides[sched.slideIndex];
      const base = sched.startTime;
      const nextSlideStart =
        idx < schedules.length - 1 ? schedules[idx + 1].startTime : totalDuration;

      const tQ = base + sched.tQuestionStart;
      const opt0Time = base + sched.tOptionStarts[0];
      const tThink = base + sched.tThinkingStart;
      const tSus = base + sched.tSuspenseStart;
      const tReveal = base + sched.tRevealStart;

      // 1. Question enter: monophonic voiceover (bounded before countdown ticks!) OR short SFX
      const qBuf = lookupBuf(slide?.voiceover?.question?.dataUrl);
      if (slide?.slideType === 'storyScene') {
        if (qBuf) {
          voiceQueue.push({
            start: tQ,
            buffer: qBuf,
            volume: 1,
            maxEnd: Math.max(tQ + 0.2, nextSlideStart - 0.02),
          });
        }
        continue;
      }

      const optCount =
        slide?.slideType === 'trueFalse' || slide?.slideType === 'versus'
          ? 2
          : slide?.slideType === 'clues' || slide?.slideType === 'multiple3'
            ? 3
            : 4;
      const hasAnyOptVoice = Array.from({ length: optCount }).some((_, oi) =>
        Boolean(lookupBuf(slide?.voiceover?.options?.[oi]?.dataUrl))
      );
      if (qBuf) {
        const qBound = hasAnyOptVoice
          ? Math.max(tQ + 0.15, opt0Time - 0.02)
          : Math.max(tQ + 0.15, tThink - 0.03);
        voiceQueue.push({
          start: tQ,
          buffer: qBuf,
          volume: 1,
          maxEnd: Math.min(nextSlideStart - 0.02, qBound),
        });
      } else {
        this.scheduleSlotInOffline(
          offline,
          limiter,
          audio.questionEnter,
          lookupBuf(audio.questionEnter.customDataUrl),
          tQ,
          Math.max(tQ + 0.15, opt0Time - 0.02),
          false,
          timing.suspenseDuration
        );
      }

      // 2. Options enter: strictly non-overlapping voiceover per option OR short SFX
      let optVoiceCursor = opt0Time;
      for (let oIdx = 0; oIdx < optCount; oIdx++) {
        const tOpt = base + sched.tOptionStarts[oIdx];
        const sameAsPrev =
          oIdx > 0 && Math.abs(sched.tOptionStarts[oIdx] - sched.tOptionStarts[oIdx - 1]) < 0.01;
        // Find the next distinct phase/row start strictly after tOpt (fixes rowByRow where opt 0 & 1 share t0)
        let groupEndBoundary = tThink;
        for (let k = oIdx + 1; k < optCount; k++) {
          const cand = base + sched.tOptionStarts[k];
          if (cand > tOpt + 0.01) {
            groupEndBoundary = cand;
            break;
          }
        }
        const oBuf = lookupBuf(slide?.voiceover?.options?.[oIdx]?.dataUrl);
        if (oBuf) {
          const actualStart = Math.max(tOpt, optVoiceCursor);
          const maxBound = Math.min(
            nextSlideStart - 0.03,
            Math.max(actualStart + 0.15, groupEndBoundary - 0.02)
          );
          if (actualStart < maxBound - 0.04) {
            voiceQueue.push({
              start: actualStart,
              buffer: oBuf,
              volume: 1,
              maxEnd: maxBound,
            });
            optVoiceCursor = Math.min(maxBound, actualStart + oBuf.duration + 0.04);
          }
        } else if (!sameAsPrev) {
          this.scheduleSlotInOffline(
            offline,
            limiter,
            audio.optionEnter,
            lookupBuf(audio.optionEnter.customDataUrl),
            tOpt,
            Math.max(tOpt + 0.15, groupEndBoundary - 0.02),
            false,
            timing.suspenseDuration
          );
        }

        if (template.optionAppearSfx && template.optionAppearSfx !== 'none' && !sameAsPrev) {
          this.playBuiltInSfx(
            template.optionAppearSfx,
            template.optionAppearSfxVolume ?? 0.45,
            offline,
            limiter,
            tOpt,
            false,
            timing.suspenseDuration,
            Math.max(0.1, Math.min(0.85, groupEndBoundary - tOpt - 0.02))
          );
        }
      }

      // 3. Countdown ticks: strictly bounded so ticks never overlap each other or bleed into suspense
      const totalTicks = Math.floor(sched.thinkingDuration);
      const tickBuf = lookupBuf(audio.countdownTick.customDataUrl);
      const doubleBeat = Boolean(template.timerUrgentDoubleBeat);
      for (let sec = 0; sec < totalTicks; sec++) {
        const tTick = tThink + sec;
        const tickSecond = totalTicks - sec;
        const isUrgentSec = tickSecond <= urgentThreshold;
        const nextTickOrSus = Math.min(tTick + (doubleBeat && isUrgentSec ? 0.42 : 0.88), tSus - 0.02);
        this.scheduleSlotInOffline(
          offline,
          limiter,
          audio.countdownTick,
          tickBuf,
          tTick,
          Math.max(tTick + 0.08, nextTickOrSus),
          isUrgentSec,
          timing.suspenseDuration
        );
        if (doubleBeat && isUrgentSec) {
          const tHalf = tTick + 0.5;
          if (tHalf < tSus - 0.08) {
            this.scheduleSlotInOffline(
              offline,
              limiter,
              audio.countdownTick,
              tickBuf,
              tHalf,
              Math.max(tHalf + 0.08, Math.min(tHalf + 0.42, tSus - 0.02)),
              true,
              timing.suspenseDuration
            );
          }
        }
      }

      // 4. Suspense: duration-matched synth OR custom clip trimmed cleanly before reveal
      const susDur = Math.max(0, timing.suspenseDuration ?? 0);
      if (susDur > 0) {
        this.scheduleSlotInOffline(
          offline,
          limiter,
          audio.suspense,
          lookupBuf(audio.suspense.customDataUrl),
          tSus,
          Math.max(tSus + 0.15, tReveal - 0.02),
          false,
          susDur
        );
      }

      // 5. Correct Answer Reveal: voiceover OR fanfare, strictly bounded before next slide
      const ansBuf = lookupBuf(slide?.voiceover?.answer?.dataUrl);
      const expBuf = lookupBuf(slide?.voiceover?.explanation?.dataUrl);
      if (ansBuf) {
        voiceQueue.push({
          start: tReveal,
          buffer: ansBuf,
          volume: 1,
          maxEnd: Math.min(totalDuration, nextSlideStart - 0.02),
        });
      } else {
        this.scheduleSlotInOffline(
          offline,
          limiter,
          audio.correctReveal,
          lookupBuf(audio.correctReveal.customDataUrl),
          tReveal,
          Math.min(totalDuration, nextSlideStart - 0.03),
          false,
          susDur
        );
      }

      if (expBuf) {
        const expStart = tReveal + (ansBuf ? ansBuf.duration + 0.15 : 0.45);
        const expMaxEnd = Math.min(totalDuration, nextSlideStart - 0.02);
        if (expStart < expMaxEnd - 0.08) {
          voiceQueue.push({
            start: expStart,
            buffer: expBuf,
            volume: 1,
            maxEnd: expMaxEnd,
          });
        }
      }
    }

    // 6. End Card Outro Voiceover (Subscribe CTA)
    const endDur = getEndCardDuration(template);
    if (endDur > 0) {
      const contentEnd = getSlidesContentDuration(slides, timing, audio, template);
      const endBuf = lookupBuf(template.endCardAudio?.dataUrl);
      if (endBuf && contentEnd < totalDuration - 0.08) {
        voiceQueue.push({
          start: contentEnd,
          buffer: endBuf,
          volume: 1,
          maxEnd: totalDuration - 0.03,
        });
      }
    }

    // 6.5 Real AI Human Presenter Audio Track (with exact trim, bg music ducking & exclusive voice priority)
    const activeAiSpeechRanges: Array<{ start: number; end: number }> = [];
    if (template.aiPresenter?.enabled && template.aiPresenter.mediaKey && (template.aiPresenter.volume ?? 1) > 0.01) {
      const aiBuf = await decodeAiPresenterAudioBuffer(template.aiPresenter.mediaKey, offline);
      if (aiBuf) {
        const aiWindows = getAiPresenterPlaybackWindows(slides, template, timing, audio);
        for (const w of aiWindows) {
          const playDur = Math.min(w.timelineEnd - w.timelineStart, Math.max(0, aiBuf.duration - w.trimStart));
          if (playDur > 0.04) {
            this.playBufferSlice(
              aiBuf,
              w.volume,
              w.trimStart,
              playDur,
              limiter,
              offline,
              w.timelineStart,
              'aiPresenter'
            );
            activeAiSpeechRanges.push({ start: w.timelineStart, end: w.timelineStart + playDur });
            if (playDur > 0.2) {
              speechIntervals.push({ start: w.timelineStart, end: w.timelineStart + playDur });
            }
          }
        }
      }
    }

    const suppressSlideVoicesForAi =
      activeAiSpeechRanges.length > 0 && template.aiPresenter?.muteOtherVoices !== false;

    // Enforce strictly monophonic non-overlapping Voice bus across the whole video
    voiceQueue.sort((a, b) => a.start - b.start);
    for (let i = 0; i < voiceQueue.length; i++) {
      const curr = voiceQueue[i];
      if (
        suppressSlideVoicesForAi &&
        activeAiSpeechRanges.some(
          (r) => curr.start >= r.start - 0.12 && curr.start <= r.end - 0.05
        )
      ) {
        continue;
      }
      const nextVoice = voiceQueue[i + 1];
      const hardEnd = nextVoice
        ? Math.min(curr.maxEnd, Math.max(curr.start + 0.04, nextVoice.start - 0.02))
        : curr.maxEnd;
      const effectiveEnd = Math.min(curr.start + curr.buffer.duration, hardEnd);
      if (effectiveEnd > curr.start + 0.04) {
        this.scheduleBufferWithEnvelope(
          offline,
          curr.buffer,
          curr.volume,
          limiter,
          curr.start,
          effectiveEnd
        );
        if (effectiveEnd - curr.start > 0.2) {
          speechIntervals.push({ start: curr.start, end: effectiveEnd });
        }
      }
    }

    // Schedule looping Background Music & Ambient Bed with clean start/end fades + merged Auto-Ducking
    const bgCfg = audio.bgMusic;
    let hasBg = false;
    if (bgCfg && bgCfg.volume > 0.001 && bgCfg.sourceType === 'custom' && bgCfg.customDataUrl) {
      const bgBuf = lookupBuf(bgCfg.customDataUrl);
      if (bgBuf) {
        hasBg = true;
        const bgSrc = offline.createBufferSource();
        bgSrc.buffer = bgBuf;
        bgSrc.loop = true;

        const bgGain = offline.createGain();
        const baseVol = bgCfg.volume;
        const fadeInEnd = Math.min(0.18, totalDuration * 0.2);
        const tailStart = Math.max(fadeInEnd + 0.08, totalDuration - 0.45);
        bgGain.gain.setValueAtTime(0.0001, 0);
        bgGain.gain.linearRampToValueAtTime(baseVol, fadeInEnd);

        bgSrc.connect(bgGain);
        bgGain.connect(limiter);
        this.bgNodes.set(offline, { gain: bgGain, baseVolume: baseVol });

        try {
          bgGain.gain.setValueAtTime(baseVol, tailStart);
          bgGain.gain.linearRampToValueAtTime(0.0001, totalDuration + 0.05);
        } catch {
          // ignore
        }

        bgSrc.start(0);
        bgSrc.stop(totalDuration + 0.08);
      }
    }

    const ambCfg = audio.ambient;
    let hasAmbient = false;
    let ambGainNode: GainNode | null = null;
    if (ambCfg && ambCfg.volume > 0.001) {
      const ambBuf =
        ambCfg.sourceType === 'custom' && ambCfg.customDataUrl
          ? lookupBuf(ambCfg.customDataUrl)
          : ambCfg.id !== 'none'
            ? this.getOrCreateAmbientBuffer(ambCfg.id, offline)
            : null;
      if (ambBuf) {
        hasAmbient = true;
        const ambSrc = offline.createBufferSource();
        ambSrc.buffer = ambBuf;
        ambSrc.loop = true;

        const ambGain = offline.createGain();
        ambGainNode = ambGain;
        const baseVol = ambCfg.volume;
        const fadeInEnd = Math.min(0.25, totalDuration * 0.22);
        const tailStart = Math.max(fadeInEnd + 0.08, totalDuration - 0.5);
        ambGain.gain.setValueAtTime(0.0001, 0);
        ambGain.gain.linearRampToValueAtTime(baseVol, fadeInEnd);

        ambSrc.connect(ambGain);
        ambGain.connect(limiter);
        this.ambientNodes.set(offline, {
          gain: ambGain,
          baseVolume: baseVol,
          autoDuck: ambCfg.autoDuck !== false,
        });

        ambSrc.start(0);
        ambSrc.stop(totalDuration + 0.08);
      }
    }

    if (
      (hasBg || hasAmbient) &&
      timing.autoDuckMusic !== false &&
      speechIntervals.length > 0 &&
      totalDuration > 0.7
    ) {
      const fadeInEnd = Math.min(0.25, totalDuration * 0.22);
      const tailStart = Math.max(fadeInEnd + 0.08, totalDuration - 0.5);
      if (tailStart > fadeInEnd + 0.2) {
        this.scheduleBgDuckIntervals(
          offline,
          speechIntervals,
          fadeInEnd + 0.02,
          timing.bgMusicDuckRatio ?? 0.22,
          tailStart - 0.03
        );
      }
    }

    if (ambGainNode && ambCfg && ambCfg.volume > 0.001) {
      const fadeInEnd = Math.min(0.25, totalDuration * 0.22);
      const tailStart = Math.max(fadeInEnd + 0.08, totalDuration - 0.5);
      try {
        ambGainNode.gain.setValueAtTime(ambCfg.volume, tailStart);
        ambGainNode.gain.linearRampToValueAtTime(0.0001, totalDuration + 0.05);
      } catch {
        // ignore
      }
    }

    const renderTimeout = new Promise<AudioBuffer | null>((resolve) => {
      window.setTimeout(() => resolve(null), 12_000);
    });
    const rendered = await Promise.race([
      offline.startRendering().catch(() => null),
      renderTimeout,
    ]);
    if (!rendered) {
      return null;
    }
    return { buffer: rendered, speechIntervals };
  }

  private scheduleSlotInOffline(
    ctx: BaseAudioContext,
    dest: AudioNode,
    config: AudioSlotConfig,
    customBuffer: AudioBuffer | null,
    when: number,
    maxEndTime: number,
    urgent: boolean,
    suspenseDurationSec: number
  ): void {
    if (!config || config.volume <= 0.001) return;
    if (config.sourceType === 'custom' && customBuffer) {
      this.scheduleBufferWithEnvelope(ctx, customBuffer, config.volume, dest, when, maxEndTime);
      return;
    }
    this.playBuiltInSfx(
      config.builtinId,
      config.volume,
      ctx,
      dest,
      when,
      urgent,
      suspenseDurationSec,
      Math.max(0.06, maxEndTime - when)
    );
  }
}

export const soundEngine = new SoundEngine();
