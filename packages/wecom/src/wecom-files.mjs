import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { within } from '../shared/io.mjs';

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export function textOf(body) {
  if (body.msgtype === 'text') return body.text?.content ?? '';
  if (body.msgtype === 'voice') return body.voice?.content ?? '';
  if (body.msgtype === 'mixed') return (body.mixed?.msg_item ?? []).filter(x => x.msgtype === 'text').map(x => x.text?.content ?? '').join('\n');
  return '';
}
export function clipText(text, maxBytes = 19000) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = ''; let bytes = 0;
  for (const char of text) { const size = Buffer.byteLength(char); if (bytes + size > maxBytes) break; result += char; bytes += size; }
  return `${result}\n\n（完整内容见附件）`;
}
export async function incomingFiles(client, body, workspace) {
  if (body.msgtype !== 'file') return [];
  if (!body.file?.url) throw new Error('文件消息缺少下载地址');
  const { buffer, filename } = await client.downloadFile(body.file.url, body.file.aeskey);
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error('当前接入支持不超过 20 MB 的文件');
  const name = basename(String(filename ?? 'attachment').replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '_') || 'attachment';
  const tag = createHash('sha256').update(body.msgid).digest('hex').slice(0, 12);
  const directory = resolve(workspace, 'inbox'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${tag}-${name}`); await writeFile(path, buffer, { mode: 0o600 });
  return [path];
}
export async function outgoingFiles(network, run, answer) {
  const runs = [run];
  for (let i = 0; i < runs.length; i++) {
    const parent = runs[i];
    for (const id of parent.resultRunIds ?? []) if (!runs.some(entry => entry.runId === id)) {
      const result = await network.getResult(id).catch(() => null);
      if (result) runs.push(result);
    }
    for (const child of network.runs.values()) {
      if (child.parentRunId === parent.runId && !runs.some(x => x.runId === child.runId)) runs.push(child);
    }
  }
  const chosen = [];
  for (const entry of runs) for (const file of entry.outputFiles ?? []) {
    if (!answer.includes(file.path) || chosen.some(x => x.path === file.path)) continue;
    const canonical = await realpath(file.path);
    if (!within(await realpath(entry.workspace), canonical)) continue;
    const info = await stat(canonical);
    if (info.isFile() && info.size <= MAX_MEDIA_BYTES) chosen.push({ path: canonical, filename: basename(canonical) });
  }
  if (Buffer.byteLength(answer) > 19000) {
    const file = resolve(run.workspace, `reply-${run.runId}.md`);
    await writeFile(file, answer, { mode: 0o600 });
    chosen.unshift({ path: file, filename: basename(file) });
  }
  return chosen.slice(0, 3);
}
export async function sendFiles(client, chatid, files) {
  let count = 0;
  for (const file of files) {
    const media = await client.uploadMedia(await readFile(file.path), { type: 'file', filename: file.filename });
    const ack = await client.sendMediaMessage(chatid, 'file', media.media_id);
    if (ack.errcode !== undefined && ack.errcode !== 0) throw new Error(`附件发送失败：${ack.errcode}`);
    count++;
  }
  return count;
}
