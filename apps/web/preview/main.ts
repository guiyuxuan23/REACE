import { TraceApiClient, TraceApiError } from '../src/services/trace-api.ts';
import { element, zh } from './copy.ts';
import { setupCamera, speakText } from './media.ts';
import { setupMemory } from './memory.ts';

const browserOnly = document.documentElement.dataset.traceMode === 'browser';
const localToken = document.querySelector<HTMLMetaElement>('meta[name=trace-development-token]')?.content;
const token = browserOnly ? crypto.randomUUID() : localToken;
const transport = browserOnly ? (await import('./browser-api.mjs')).createBrowserTransport() : undefined;
const client = new TraceApiClient(
  { mode: 'mock', baseUrl: browserOnly ? 'http://127.0.0.1:8001' : location.origin, timeoutMs: 7000 },
  { fetch: transport, token: () => token },
);
if (browserOnly) element('memory-help').textContent = '先预览，再决定是否保存。演练记录仅在此页面内，刷新即清空。';
const large = element<HTMLButtonElement>('large');
large.onclick = () => large.setAttribute('aria-pressed', String(document.body.classList.toggle('large')));

const form = element<HTMLFormElement>('goal-form');
const goal = element<HTMLTextAreaElement>('goal');
const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
const cancel = element<HTMLButtonElement>('cancel');
const confirmation = element<HTMLButtonElement>('confirm-goal');
const result = element('agent-result');
const lesson = element('lesson');
const completion = element('completion');
const status = element('practice-status');
const stopCamera = setupCamera();
let request: AbortController | undefined;
let step = 0;
let done = 0;
let skipped = 0;

form.onsubmit = async event => {
  event.preventDefault();
  const text = goal.value.trim();
  if (request || !text) return;
  const active = new AbortController();
  request = active;
  submit.disabled = true;
  cancel.hidden = false;
  confirmation.hidden = true;
  result.hidden = true;
  status.textContent = '正在准备自然妆演练。';
  try {
    const reply = await client.sendAgentMessage({ requestId: crypto.randomUUID(), locale: 'zh-CN', message: { kind: 'text', text } }, { signal: active.signal });
    result.textContent = `${reply.data.content.display.text} 可选择固定的自然妆演练。`;
    result.hidden = false;
    status.textContent = '';
    confirmation.hidden = false;
    confirmation.focus();
  } catch (error) {
    status.textContent = error instanceof TraceApiError && error.code === 'CANCELLED' ? '已取消本次等待，可以重新提交。' : zh.callFailed;
  } finally {
    request = undefined;
    submit.disabled = false;
    cancel.hidden = true;
  }
};
cancel.onclick = () => { request?.abort(); goal.focus(); };

function showStep() {
  const current = zh.steps[step];
  element('progress').textContent = `第 ${step + 1} 步，共 ${zh.steps.length} 步`;
  element('step-title').textContent = current.title;
  element('step-body').textContent = current.body;
  element('step-title').focus();
}

function finish(early: boolean) {
  lesson.hidden = true;
  completion.hidden = false;
  stopCamera();
  element('completion-text').textContent = `${early ? '已提前结束演练。' : '自然妆演练完成。'}完成 ${done} 步，跳过 ${skipped} 步。没有生成妆效结论。`;
  element('completion-title').focus();
}

confirmation.onclick = () => {
  form.hidden = true;
  result.hidden = true;
  confirmation.hidden = true;
  lesson.hidden = false;
  step = done = skipped = 0;
  showStep();
};
function advance(completed: boolean) {
  if (completed) done++;
  else skipped++;
  if (++step === zh.steps.length) finish(false);
  else showStep();
}
element('next').onclick = () => advance(true);
element('skip-step').onclick = () => advance(false);
element('repeat').onclick = () => speakText(`${zh.steps[step].title}。${zh.steps[step].body}`, status);
element('stop-lesson').onclick = () => finish(true);
element('read-completion').onclick = () => speakText(element('completion-text').textContent ?? '', status);
element('reset').onclick = () => { status.textContent = ''; completion.hidden = true; form.hidden = false; goal.focus(); };

const sample = element<HTMLButtonElement>('sample');
const observation = element('camera-status');
const readObservation = element<HTMLButtonElement>('read-observation');
sample.onclick = async () => {
  sample.disabled = true;
  readObservation.hidden = true;
  try {
    const result = await client.analyzeVision({
      task: 'cheek_color_balance', authorization: { scope: 'local_observation', granted: true },
      observation: { captureId: crypto.randomUUID(), capturedAt: new Date().toISOString(), methodVersion: 'synthetic-preview', coordinateSpace: 'unknown', quality: 'unknown' },
    });
    if (result.data.status !== 'inconclusive' || result.data.predictions.length) throw new Error('Unexpected mock evidence');
    observation.textContent = zh.sample;
    readObservation.hidden = false;
  } catch { observation.textContent = zh.callFailed; }
  finally { sample.disabled = false; }
};
readObservation.onclick = () => speakText(zh.sample, status);
addEventListener('pagehide', () => { request?.abort(); window.speechSynthesis?.cancel(); });
setupMemory(client);
for (const button of [large, submit, sample, element<HTMLButtonElement>('camera-open'), element<HTMLButtonElement>('propose')]) {
  button.disabled = false;
}
status.textContent = '';
