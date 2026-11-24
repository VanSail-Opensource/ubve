<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { createReferencePlayer } from '@ubve/browser';
import type { MediaInput, PlayerSnapshot, ReferencePlayer, QualityMode, RoutePreference } from '@ubve/browser';
import Icon from './components/Icon.vue';
import { messages } from './i18n';
import type { Locale } from './i18n';

interface QueueItem { id: string; name: string; size: number | null; kind: 'local' | 'url' }
const media = ref<HTMLVideoElement>();
const overlay = ref<HTMLElement>();
const playerHost = ref<HTMLElement>();
const fileInput = ref<HTMLInputElement>();
const subtitleInput = ref<HTMLInputElement>();
const urlDialog = ref<HTMLDialogElement>();
const urlInput = ref<HTMLInputElement>();
const player = shallowRef<ReferencePlayer>();
const snapshot = shallowRef<PlayerSnapshot>();
const queue = ref<QueueItem[]>([]);
const inputs = new Map<string, MediaInput>();
const selectedId = ref<string | null>(null);
const locale = ref<Locale>('en');
const t = computed(() => messages[locale.value]);
const routePreference = ref<RoutePreference>('automatic');
const allowStereoFoldDown = ref(false);
const preferWebGpu = ref(false);
const webGpuApiAvailable = Boolean(navigator.gpu);
const pgsPalette = ref<'bt709-limited' | 'bt601-limited'>('bt709-limited');
const url = ref('');
const toast = ref<string | null>(null);
const dragging = ref(false);
const dragDepth = ref(0);
const settingsOpen = ref(false);
const browserControls = ref(false);
const showInspector = ref(true);
const seekDraft = ref<number | null>(null);
const fullscreenSupported = ref(false);
const pipSupported = ref(false);
let unsubscribe: (() => void) | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const hasSource = computed(() => snapshot.value?.source !== null && snapshot.value?.source !== undefined);
const playable = computed(() => hasSource.value && !['opening', 'failed', 'disposed'].includes(snapshot.value?.state ?? 'empty'));
const isPlaying = computed(() => snapshot.value?.state === 'playing');
const wantsPlayback = computed(() => snapshot.value?.wantsPlayback ?? false);
const seekable = computed(() => playable.value && (snapshot.value?.duration ?? 0) > 0);
const nativePicture = computed(() => playable.value && Boolean(snapshot.value?.route?.startsWith('N')) && Boolean(media.value?.videoWidth));
const nativeControlsAvailable = computed(() => nativePicture.value && !snapshot.value?.requiresOverlay);
const routeUsesManagedClock = computed(() => snapshot.value?.route === 'C1');
const busy = computed(() => ['opening', 'seeking', 'rebuffering'].includes(snapshot.value?.state ?? ''));
const currentIndex = computed(() => queue.value.findIndex(item => item.id === selectedId.value));
const audioTracks = computed(() => snapshot.value?.tracks.filter(track => track.kind === 'audio') ?? []);
const stateLabel = computed(() => t.value[snapshot.value?.state ?? 'empty']);
const position = computed(() => seekDraft.value ?? snapshot.value?.time ?? 0);
const percent = computed(() => snapshot.value?.duration ? position.value / snapshot.value.duration * 100 : 0);
const routeNames = computed<Record<RoutePreference, string>>(() => ({ automatic: t.value.automatic, native: t.value.nativeDirect, experimental: t.value.nativeBridge, managed: t.value.managed }));
watch(locale, value => { document.documentElement.lang = value; });

function notify(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  toast.value = error instanceof Error ? error.message : String(error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 12_000);
}
async function act(action: () => unknown | Promise<unknown>): Promise<void> {
  try { await action(); } catch (error) { notify(error); }
}
function time(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(total % 60).padStart(2, '0')}`;
}
function bytes(size: number | null): string {
  if (size === null) return t.value.unknown;
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024)) - 1);
  return `${(size / 1024 ** (unit + 1)).toFixed(unit > 0 ? 2 : 0)} ${units[unit]}`;
}
function metric(value: number | null | undefined, decimals = 0): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString(locale.value, { maximumFractionDigits: decimals });
}
function savePreferences(): void {
  try { localStorage.setItem('ubve.preferences.v1', JSON.stringify({ locale: locale.value, quality: snapshot.value?.quality ?? 'full', volume: snapshot.value?.volume ?? 1, muted: snapshot.value?.muted ?? false })); } catch { /* Private contexts may refuse persistence. */ }
}
async function openItem(id: string): Promise<void> {
  const input = inputs.get(id); if (!input || !player.value) return;
  selectedId.value = id;
  seekDraft.value = null;
  toast.value = null;
  await player.value.open(input);
}
async function addFiles(list: FileList | File[]): Promise<void> {
  const files = Array.from(list);
  const subtitles = files.filter(file => /\.(ass|ssa|vtt|srt|ttml|dfxp|sup)$/i.test(file.name));
  const sources = files.filter(file => !subtitles.includes(file));
  let firstId: string | null = null;
  for (const file of sources) {
    const id = crypto.randomUUID();
    inputs.set(id, file); queue.value.push({ id, name: file.name, size: file.size, kind: 'local' });
    firstId ??= id;
  }
  if (firstId) await openItem(firstId);
  if (subtitles[0] && player.value) await player.value.loadSubtitle(subtitles[0], { pgsPalette: pgsPalette.value });
}
async function chooseFiles(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  if (target.files) await act(() => addFiles(target.files!));
  target.value = '';
}
async function addUrl(): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url.value.trim()); } catch { notify(t.value.invalidUrl); return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { notify(t.value.invalidUrl); return; }
  const id = crypto.randomUUID();
  let name = parsed.pathname.split('/').pop() || parsed.hostname;
  try { name = decodeURIComponent(name); } catch { /* Retain an escaped label if it cannot be decoded. */ }
  inputs.set(id, { url: parsed.href }); queue.value.push({ id, name, size: null, kind: 'url' });
  urlDialog.value?.close(); url.value = '';
  await act(() => openItem(id));
}
function openUrlDialog(): void { urlDialog.value?.showModal(); queueMicrotask(() => urlInput.value?.focus()); }
async function togglePlayback(): Promise<void> {
  if (wantsPlayback.value) await act(() => player.value?.pause()); else await act(() => player.value?.play());
}
async function relativeFile(delta: number): Promise<void> {
  const item = queue.value[currentIndex.value + delta]; if (item) await act(() => openItem(item.id));
}
async function seekTo(): Promise<void> {
  if (seekDraft.value === null) return;
  const target = seekDraft.value; seekDraft.value = null;
  await act(() => player.value?.seek(target));
}
async function fullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen(); else await playerHost.value?.requestFullscreen();
}
async function pictureInPicture(): Promise<void> {
  if (!media.value || !nativeControlsAvailable.value || !pipSupported.value) return;
  if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await media.value.requestPictureInPicture();
}
function quality(mode: QualityMode): void { void act(async () => { await player.value?.setQuality(mode); savePreferences(); }); }
function volume(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  player.value?.setVolume(value);
  if (value > 0 && snapshot.value?.muted) player.value?.setMuted(false);
  savePreferences();
}
function mute(): void { player.value?.setMuted(!snapshot.value?.muted); savePreferences(); }
function onDrop(event: DragEvent): void {
  dragging.value = false; dragDepth.value = 0;
  if (event.dataTransfer?.files.length) void act(() => addFiles(event.dataTransfer!.files));
}
function removeQueueItem(id: string): void {
  if (id === selectedId.value) { void act(() => player.value?.close()); selectedId.value = null; }
  inputs.delete(id); queue.value = queue.value.filter(item => item.id !== id);
}
function clearQueue(): void {
  void act(() => player.value?.close()); inputs.clear(); queue.value = []; selectedId.value = null;
}
function keyboard(event: KeyboardEvent): void {
  if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName))) return;
  if (event.altKey || event.ctrlKey || event.metaKey || urlDialog.value?.open) return;
  switch (event.key.toLowerCase()) {
    case ' ': case 'k': if (playable.value) { event.preventDefault(); void togglePlayback(); } break;
    case 'arrowleft': if (seekable.value) { event.preventDefault(); void act(() => player.value?.seek((snapshot.value?.time ?? 0) - 5)); } break;
    case 'arrowright': if (seekable.value) { event.preventDefault(); void act(() => player.value?.seek((snapshot.value?.time ?? 0) + 5)); } break;
    case 'm': mute(); break;
    case 'f': if (fullscreenSupported.value) void act(fullscreen); break;
    case 'escape': settingsOpen.value = false; break;
  }
}
function exportDiagnostics(): void {
  const data = { schema: 'ubve-session-diagnostics-1', capturedAt: new Date().toISOString(), userAgent: navigator.userAgent, crossOriginIsolated, snapshot: snapshot.value, pipeline: player.value?.diagnostics(), note: 'Browser observations only. Physical HDR/audio output and full 60/120 gates remain unqualified.' };
  const blob = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = blob; anchor.download = 'ubve-session-diagnostics.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}

onMounted(() => {
  if (!media.value || !overlay.value) return;
  player.value = createReferencePlayer({ video: media.value, overlay: overlay.value, routePreference: () => routePreference.value, allowStereoFoldDown: () => allowStereoFoldDown.value, preferWebGpu: () => preferWebGpu.value });
  unsubscribe = player.value.subscribe(value => { snapshot.value = value; });
  try {
    const preference = JSON.parse(localStorage.getItem('ubve.preferences.v1') ?? '{}') as Record<string, unknown>;
    if (preference.locale === 'en' || preference.locale === 'zh-CN' || preference.locale === 'zh-TW') locale.value = preference.locale;
    if (preference.quality === 'full' || preference.quality === 'performance') void act(() => player.value?.setQuality(preference.quality as QualityMode));
    if (typeof preference.volume === 'number') player.value.setVolume(preference.volume);
    if (typeof preference.muted === 'boolean') player.value.setMuted(preference.muted);
  } catch { /* Keep functional defaults when preferences are unavailable or malformed. */ }
  fullscreenSupported.value = Boolean(document.fullscreenEnabled);
  pipSupported.value = Boolean(document.pictureInPictureEnabled && media.value.requestPictureInPicture);
  document.addEventListener('keydown', keyboard);
});
onBeforeUnmount(() => { unsubscribe?.(); document.removeEventListener('keydown', keyboard); clearTimeout(toastTimer); void player.value?.dispose(); });
</script>

<template>
  <div class="app-shell" :class="{ 'inspector-hidden': !showInspector }" @dragenter.prevent="dragDepth++; dragging = true" @dragover.prevent @dragleave.prevent="dragDepth--; if (dragDepth <= 0) dragging = false" @drop.prevent="onDrop">
    <header class="topbar">
      <a class="brand" href="./" aria-label="UBVE home"><span class="brand-symbol"><i></i><i></i><i></i></span><span>ubve<span class="brand-dot">.</span></span></a>
      <div class="header-divider"></div><span class="app-label">{{ t.player }}</span>
      <div class="top-actions"><span class="privacy-label"><Icon name="shield" :size="16" />{{ t.local }}</span><button class="quiet-button inspector-toggle" :aria-pressed="showInspector" @click="showInspector = !showInspector"><Icon name="settings" :size="17" />{{ t.inspector }}</button><button class="button button-small" @click="fileInput?.click()"><Icon name="plus" :size="16" />{{ t.open }}</button></div>
    </header>

    <main class="workspace">
      <section class="main-column" aria-label="Media player">
        <div class="section-heading"><div><p class="eyebrow">UNIVERSAL BROWSER VIDEO ENGINE</p><h1>{{ hasSource ? snapshot?.source?.name : t.tagline }}</h1></div><span class="session-state" :class="{ active: isPlaying }"><span class="state-dot"></span>{{ stateLabel }}</span></div>
        <div ref="playerHost" class="player-host" :class="{ 'has-source': hasSource, 'is-busy': busy }">
          <div class="video-stage" @dblclick="fullscreenSupported && act(fullscreen)" @click.self="routeUsesManagedClock && playable && togglePlayback()">
            <video ref="media" class="video" :controls="browserControls && nativeControlsAvailable" :disable-picture-in-picture="!nativeControlsAvailable" playsinline preload="metadata" :aria-label="snapshot?.source?.name ?? t.player" @click="playable && !(browserControls && nativeControlsAvailable) && togglePlayback()"></video>
            <div ref="overlay" class="subtitle-overlay"></div>
            <div v-if="!hasSource" class="empty-stage">
              <div class="stage-mark" aria-hidden="true"><span></span><span></span><span></span></div>
              <h2>{{ t.drop }}</h2><p>{{ t.dropHint }}</p>
              <div class="empty-actions"><button class="button button-primary" @click="fileInput?.click()"><Icon name="folder" :size="19" />{{ t.choose }}</button><span>{{ t.or }}</span><button class="text-button" @click="openUrlDialog">{{ t.openUrl }}</button></div>
              <p class="private-note"><Icon name="shield" :size="14" />{{ t.private }}</p>
            </div>
            <div v-if="busy" class="busy-overlay" role="status"><span class="spinner"></span><span>{{ stateLabel }}</span></div>
            <div v-if="snapshot?.state === 'failed'" class="stage-error"><Icon name="info" :size="28" /><strong>{{ t.issueTitle }}</strong><p>{{ snapshot.error?.message }}</p><button class="button" @click="selectedId && act(() => openItem(selectedId!))"><Icon name="refresh" :size="16" />{{ t.retry }}</button></div>
            <div v-if="hasSource && snapshot?.state === 'ready'" class="first-play"><button class="large-play" :aria-label="t.play" @click="togglePlayback"><Icon name="play" :size="30" /></button></div>
            <span v-if="hasSource" class="stage-label">{{ snapshot?.route ?? '…' }}<template v-if="snapshot?.source?.width"> · {{ snapshot.source.width }} × {{ snapshot.source.height }}</template></span>
          </div>
          <div class="transport">
            <label class="sr-only" for="seek-position">{{ t.position }}</label><input id="seek-position" class="timeline" type="range" min="0" :max="snapshot?.duration || 1" step="any" :value="position" :disabled="!seekable" :style="{ '--progress': `${percent}%` }" :aria-valuetext="`${time(position)} / ${seekable ? time(snapshot?.duration ?? 0) : t.unknown}`" @input="seekDraft = Number(($event.target as HTMLInputElement).value)" @change="seekTo" />
            <div class="transport-row">
              <button class="icon-button transport-play" :aria-label="wantsPlayback ? t.pause : t.play" :disabled="!playable" @click="togglePlayback"><Icon :name="wantsPlayback ? 'pause' : 'play'" :size="23" /></button>
              <button class="icon-button optional-control" :aria-label="t.previous" :disabled="currentIndex <= 0" @click="relativeFile(-1)"><Icon name="back" :size="18" /></button><button class="icon-button optional-control" :aria-label="t.next" :disabled="currentIndex < 0 || currentIndex >= queue.length - 1" @click="relativeFile(1)"><Icon name="next" :size="18" /></button>
              <span class="time-display">{{ time(position) }}<span>/ {{ seekable ? time(snapshot?.duration ?? 0) : '—' }}</span></span>
              <div class="volume-control"><button class="icon-button" :aria-label="snapshot?.muted ? t.unmute : t.mute" @click="mute"><Icon :name="snapshot?.muted || snapshot?.volume === 0 ? 'muted' : 'volume'" :size="19" /></button><input type="range" min="0" max="1" step="0.01" :value="snapshot?.muted ? 0 : snapshot?.volume ?? 1" :aria-label="t.volume" @input="volume" /></div>
              <span class="transport-spacer"></span>
              <button class="icon-button" :class="{ 'is-selected': snapshot?.subtitleLabel }" :aria-label="t.subtitleLoad" :disabled="!playable" @click="subtitleInput?.click()"><Icon name="subtitles" /></button>
              <div class="settings-anchor"><button class="icon-button" :aria-label="t.settings" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen"><Icon name="settings" /></button><div v-if="settingsOpen" class="settings-popover"><div class="popover-heading"><strong>{{ t.settings }}</strong><button class="icon-button" :aria-label="t.close" @click="settingsOpen = false"><Icon name="close" :size="16" /></button></div><label>{{ t.rate }}<select :value="snapshot?.rate ?? 1" :disabled="routeUsesManagedClock" :title="routeUsesManagedClock ? t.managedRate : undefined" @change="act(() => player?.setRate(Number(($event.target as HTMLSelectElement).value)))"><option v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="rate" :value="rate">{{ rate }}×</option></select></label><label>{{ t.language }}<select v-model="locale" @change="savePreferences"><option value="en">English</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option></select></label><label class="checkbox-label"><span>{{ t.browserControls }}</span><input v-model="browserControls" type="checkbox" :disabled="!nativeControlsAvailable" :title="!nativeControlsAvailable ? t.customControlsRequired : undefined" /></label></div></div>
              <button class="icon-button pip-button" :aria-label="t.pip" :title="!nativeControlsAvailable ? t.pipUnavailable : t.pip" :disabled="!nativeControlsAvailable || !pipSupported" @click="act(pictureInPicture)"><Icon name="pip" /></button>
              <button class="icon-button" :aria-label="t.fullscreen" :disabled="!fullscreenSupported" @click="act(fullscreen)"><Icon name="fullscreen" /></button>
            </div>
          </div>
        </div>

        <div class="under-player"><p><Icon name="shield" :size="14" />{{ t.private }}</p><span>{{ t.shortcut }}</span></div>
        <section class="queue-panel"><div class="panel-heading"><h2>{{ t.library }}<span class="count">{{ queue.length }}</span></h2><div><button v-if="queue.length" class="text-button subdued" @click="clearQueue">{{ t.clear }}</button><button class="quiet-button" @click="fileInput?.click()"><Icon name="plus" :size="16" />{{ t.add }}</button></div></div><div v-if="!queue.length" class="empty-queue"><Icon name="film" :size="24" /><div><strong>{{ t.queueEmpty }}</strong><p>{{ t.queueHint }}</p></div></div><ol v-else class="queue-list"><li v-for="(item, index) in queue" :key="item.id" :class="{ current: item.id === selectedId }"><button class="queue-item" @click="act(() => openItem(item.id))"><span class="queue-number"><Icon v-if="item.id === selectedId" name="play" :size="14" /><template v-else>{{ String(index + 1).padStart(2, '0') }}</template></span><span class="queue-file-icon"><Icon :name="item.kind === 'url' ? 'link' : 'film'" :size="20" /></span><span class="queue-name">{{ item.name }}<small>{{ item.kind === 'local' ? bytes(item.size) : 'URL' }}</small></span><span v-if="item.id === selectedId" class="queue-current-label">{{ stateLabel }}</span></button><button class="icon-button remove-item" :aria-label="`${t.close}: ${item.name}`" @click="removeQueueItem(item.id)"><Icon name="close" :size="16" /></button></li></ol></section>
      </section>

      <aside v-show="showInspector" class="inspector">
        <section class="inspector-section playback-card"><div class="panel-heading"><h2>{{ t.output }}</h2><span class="engine-label">ENGINE v0.1</span></div><div class="quality-switch" role="group" :aria-label="t.quality"><button :class="{ selected: snapshot?.quality !== 'performance' }" :aria-pressed="snapshot?.quality !== 'performance'" :disabled="snapshot?.state === 'opening' || snapshot?.qualityChangeAvailable === false" @click="quality('full')">{{ t.full }}</button><button :class="{ selected: snapshot?.quality === 'performance' }" :aria-pressed="snapshot?.quality === 'performance'" :disabled="snapshot?.state === 'opening' || snapshot?.qualityChangeAvailable === false" @click="quality('performance')">{{ t.performance }}</button></div><p class="mode-description">{{ snapshot?.quality === 'performance' ? ((snapshot.route === 'C1' || routePreference === 'managed') ? t.managedPerfHint : t.perfHint) : t.fullHint }}</p><p v-if="snapshot?.qualityChangeAvailable === false" class="route-note">{{ t.reopenGpuQuality }}</p><div class="target-row"><div><span>{{ t.target }}</span><strong>{{ snapshot?.quality === 'performance' ? '120' : '60' }}<small>{{ t.sourcePictures }}</small></strong></div><span class="target-mark" aria-hidden="true"><Icon name="activity" :size="26" /></span></div><details class="qualification"><summary><Icon name="info" :size="15" />{{ t.qualification }}<Icon name="chevron" :size="14" /></summary><p>{{ t.qualificationHint }}</p></details>
          <label class="route-picker">{{ t.routeMode }}<select v-model="routePreference"><option v-for="(label, value) in routeNames" :key="value" :value="value">{{ label }}</option></select></label><p class="route-note">{{ routePreference === 'experimental' || routePreference === 'managed' ? t.experimentalRoute : t.routeOnOpen }}</p><label v-if="routePreference === 'managed'" class="fold-option"><input v-model="allowStereoFoldDown" type="checkbox" /><span>{{ t.stereoFold }}<small>{{ t.stereoFoldHint }}</small></span></label><label v-if="routePreference === 'managed'" class="fold-option"><input v-model="preferWebGpu" type="checkbox" :disabled="!webGpuApiAvailable" /><span>{{ t.webGpuOutput }}<small>{{ webGpuApiAvailable ? t.webGpuOutputHint : t.webGpuUnavailable }}</small></span></label><ul v-if="snapshot?.route" class="transform-list"><li v-for="transform in snapshot.transforms" :key="transform">{{ transform }}</li></ul>
        </section>
        <section class="inspector-section"><div class="panel-heading"><h2>{{ t.details }}</h2><Icon name="film" :size="17" /></div><dl v-if="hasSource" class="signal-list"><div><dt>{{ t.format }}</dt><dd>{{ snapshot?.source?.mime || t.unknown }}</dd></div><div><dt>{{ t.resolution }}</dt><dd>{{ snapshot?.source?.width ? `${snapshot.source.width} × ${snapshot.source.height}` : '—' }}</dd></div><div><dt>{{ t.bytes }}</dt><dd>{{ bytes(snapshot?.source?.bytes ?? null) }}</dd></div><div><dt>{{ t.route }}</dt><dd>{{ snapshot?.route || '—' }}<small>{{ snapshot?.routeDescription }}</small></dd></div><div><dt>{{ t.color }}</dt><dd>{{ snapshot?.source?.color }}</dd></div><div><dt>{{ t.audio }}</dt><dd>{{ snapshot?.source?.audio }}</dd></div></dl><p v-else class="muted-copy">{{ t.noSource }}</p><label v-if="audioTracks.some(track => track.selectable)" class="audio-picker">{{ t.audio }}<select :value="snapshot?.selectedAudio" :disabled="!playable || busy" @change="act(() => player?.selectAudio(($event.target as HTMLSelectElement).value))"><option v-for="track in audioTracks" :key="track.id" :value="track.id" :disabled="!track.selectable">{{ track.label }}</option></select></label></section>
        <section class="inspector-section"><div class="panel-heading"><h2>{{ t.subtitles }}</h2><Icon name="subtitles" :size="18" /></div><template v-if="snapshot?.subtitleLabel"><div class="subtitle-selected"><span>{{ snapshot.subtitleLabel }}</span><button class="icon-button" :aria-label="t.subtitleOff" @click="act(() => player?.clearSubtitle())"><Icon name="close" :size="15" /></button></div><label class="offset-control">{{ t.offset }}<span><input type="number" min="-3600" max="3600" step="0.1" :value="snapshot.subtitleOffset" :title="t.subtitleOffsetHint" @change="act(() => player?.setSubtitleOffset(Number(($event.target as HTMLInputElement).value)))" />{{ t.seconds }}</span></label></template><p v-else class="muted-copy">{{ t.subtitleHint }}</p><button class="button subtitle-add" :disabled="!playable" @click="subtitleInput?.click()"><Icon name="plus" :size="16" />{{ t.subtitleLoad }}</button><p class="supported-caption">ASS · SSA · SRT · VTT · TTML · PGS</p><label class="route-picker">{{ t.pgsPalette }}<select v-model="pgsPalette"><option value="bt709-limited">BT.709 limited range</option><option value="bt601-limited">BT.601 limited range</option></select></label></section>
        <section class="inspector-section monitor-section"><div class="panel-heading"><h2>{{ t.telemetry }}</h2><Icon name="activity" :size="18" /></div><div class="metrics"><div><span>{{ t.callbackRate }}</span><strong>{{ metric(snapshot?.telemetry.callbackRate, 1) }}<small>/s</small></strong></div><div><span>{{ t.buffer }}</span><strong>{{ hasSource ? metric(snapshot?.telemetry.bufferedSeconds, 1) : '—' }}<small>s</small></strong></div><div><span>{{ routeUsesManagedClock ? t.submitted : t.frames }}</span><strong>{{ hasSource ? metric(snapshot?.telemetry.presentedFrames) : '—' }}</strong></div><div><span>{{ routeUsesManagedClock ? t.deliberateDrops : t.dropped }}</span><strong>{{ hasSource ? metric(snapshot?.telemetry.droppedFrames) : '—' }}</strong></div></div><p class="monitor-note">{{ t.monitorHint }}</p><details v-if="snapshot?.notices.length" class="runtime-notices"><summary>{{ t.details }}</summary><p v-for="notice in snapshot.notices" :key="notice">{{ notice }}</p></details><button class="quiet-button export-button" :disabled="!hasSource" @click="exportDiagnostics"><Icon name="download" :size="15" />{{ t.export }}</button></section>
      </aside>
    </main>

    <footer class="app-footer"><span>UBVE <span class="footer-separator">/</span> VanSail Open Source</span><span>Browser only. <span class="footer-separator">/</span> No installation.</span><a href="https://github.com/VanSail-Opensource/ubve" target="_blank" rel="noreferrer">GitHub</a></footer>
    <div v-if="dragging" class="drop-screen"><Icon name="folder" :size="48" /><strong>{{ t.drop }}</strong></div>
    <div v-if="toast" class="toast" role="alert"><Icon name="info" :size="19" /><p>{{ toast }}</p><button class="icon-button" :aria-label="t.dismiss" @click="toast = null"><Icon name="close" :size="17" /></button></div>
    <dialog ref="urlDialog" class="url-dialog" @click="($event.target === urlDialog) && urlDialog?.close()"><form @submit.prevent="addUrl"><div class="dialog-heading"><span class="dialog-icon"><Icon name="link" :size="23" /></span><button type="button" class="icon-button" :aria-label="t.close" @click="urlDialog?.close()"><Icon name="close" /></button></div><h2>{{ t.urlTitle }}</h2><p>{{ t.urlHint }}</p><label for="media-url">{{ t.urlLabel }}</label><input id="media-url" ref="urlInput" v-model="url" type="url" placeholder="https://example.com/video.mp4" autocomplete="off" required /><div class="dialog-actions"><button type="button" class="button" @click="urlDialog?.close()">{{ t.cancel }}</button><button type="submit" class="button button-primary">{{ t.urlAction }}</button></div></form></dialog>
    <input ref="fileInput" class="sr-only" type="file" multiple accept="video/*,audio/*,.mkv,.m2ts,.mts,.ts,.mov,.avi,.mxf,.nut,.flv,.ogv,.mpg,.mpeg,.vob,.webm,.mp4,.wav,.flac,.mp3,.ass,.ssa,.srt,.vtt,.ttml,.sup" :aria-label="t.open" @change="chooseFiles" />
    <input ref="subtitleInput" class="sr-only" type="file" accept=".ass,.ssa,.srt,.vtt,.ttml,.dfxp,.sup" :aria-label="t.subtitleLoad" @change="act(async () => { const input = $event.target as HTMLInputElement; const selected = input.files?.[0]; input.value = ''; if (selected) await player?.loadSubtitle(selected, { pgsPalette }); })" />
  </div>
</template>
