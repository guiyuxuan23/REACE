import type { components } from '../../../packages/shared-contracts/v1.ts';
import type { TraceApiClient } from '../src/services/trace-api.ts';
import { element, zh } from './copy.ts';

type Schemas = components['schemas'];

export function setupMemory(client: TraceApiClient) {
  const form = element<HTMLFormElement>('memory-form');
  const input = element<HTMLInputElement>('preference');
  const status = element('memory-status');
  const panel = element('proposal');
  const records = element<HTMLUListElement>('records');
  const cancelEdit = element<HTMLButtonElement>('cancel-edit');
  let edit: Schemas['MemoryRecord'] | undefined;
  let proposal: Schemas['MemoryProposal'] | undefined;
  let pending = false;

  async function task(action: () => Promise<void>) {
    if (pending) return;
    pending = true;
    try { await action(); } catch { status.textContent = zh.memoryError; }
    finally { pending = false; }
  }

  function clear() {
    edit = undefined;
    proposal = undefined;
    panel.hidden = true;
    cancelEdit.hidden = true;
    input.value = '';
  }

  async function load() {
    const { data } = await client.getMemoryProfile();
    records.replaceChildren(...data.records.map(record => {
      const row = document.createElement('li');
      const text = document.createElement('p');
      text.textContent = record.preference.value;
      const buttons = document.createElement('div');
      buttons.className = 'actions';
      const revise = document.createElement('button');
      revise.textContent = '更正';
      revise.className = 'quiet';
      revise.onclick = () => {
        if (pending) return;
        clear();
        edit = record;
        cancelEdit.hidden = false;
        input.value = record.preference.value;
        input.focus();
      };
      const remove = document.createElement('button');
      remove.textContent = '删除';
      remove.className = 'quiet';
      remove.setAttribute('aria-label', `删除偏好：${record.preference.value}`);
      remove.onclick = () => {
        if (pending) return;
        const confirm = document.createElement('button');
        confirm.textContent = '确认删除';
        const cancel = document.createElement('button');
        cancel.textContent = '取消删除';
        cancel.className = 'quiet';
        confirm.onclick = () => void task(async () => {
          await client.deleteMemory(record.id);
          clear();
          await load();
          status.textContent = '演练偏好已删除。';
          input.focus();
        });
        cancel.onclick = () => { buttons.replaceChildren(revise, remove); remove.focus(); };
        buttons.replaceChildren(confirm, cancel);
        confirm.focus();
      };
      buttons.append(revise, remove);
      row.append(text, buttons);
      return row;
    }));
  }

  form.onsubmit = event => {
    event.preventDefault();
    if (!input.value.trim()) return;
    void task(async () => {
      const preference = { key: 'finish' as const, value: input.value.trim() };
      const body: Schemas['MemoryProposalRequest'] = edit
        ? { operation: 'correct', memoryId: edit.id, expectedVersion: edit.version, preference }
        : { operation: 'create', preference };
      proposal = (await client.proposeMemory(body)).data;
      element('proposal-text').textContent = `待确认：${proposal.preference.value}`;
      panel.hidden = false;
      status.textContent = '已准备演练候选，尚未保存。';
      element('save').focus();
    });
  };
  element('save').onclick = () => void task(async () => {
    if (!proposal) return;
    await client.confirmMemory({ proposalId: proposal.id, expectedVersion: proposal.version, confirmed: true });
    clear();
    await load();
    status.textContent = '已保存到本次演练。';
    input.focus();
  });
  const discard = () => {
    if (pending) return;
    clear();
    status.textContent = '已放弃，未保存偏好。';
    input.focus();
  };
  element('discard').onclick = discard;
  cancelEdit.onclick = discard;
  void task(load);
}
