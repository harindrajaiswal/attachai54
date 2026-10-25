import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const widget = fs.readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');
describe('chat widget lifetime and sharing contract', () => {
  it('starts no timer before first message and persists an absolute expiry after it', () => {
    expect(widget).toContain('startLifetime();');
    expect(widget).toContain('expiresAt:startedAt+86400000');
    expect(widget).toContain('parsed.expiresAt > Date.now()');
  });
  it('clears expired conversations and updates the countdown from absolute time', () => {
    expect(widget).toContain('const left=Math.max(0, chatRecord.expiresAt-Date.now())');
    expect(widget).toContain('if (!left) { clearChat(); return; }');
    expect(widget).toContain('localStorage.removeItem(sessionKey)');
  });
  it('provides safe per-message and complete-conversation sharing plus feedback actions', () => {
    expect(widget).toContain('Share response');
    expect(widget).toContain('Share conversation');
    expect(widget).toContain("`${clientName} Conversation`");
    expect(widget).not.toContain('Orbit AI Conversation');
    expect(widget).toContain('<svg viewBox=');
    expect(widget).toContain('aria-label="Send message"');
    expect(widget).toContain('const clientName = config.clientName || name;');
    expect(widget).toContain('Copy response');
    expect(widget).toContain('Mark response helpful');
    expect(widget).toContain('Mark response not helpful');
    expect(widget).not.toContain('apiKey,tenant');
  });
  it('provides send and clear-chat controls without changing the existing send path', () => {
    expect(widget).toContain('class="tai-chat"');
    expect(widget).toContain('aria-label="Send message"');
    expect(widget).toContain('class="tai-clear"');
    expect(widget).toContain('aria-label="Clear chat"');
    expect(widget).toContain('title="Clear chat"');
    expect(widget).toContain('clear.onclick=()=>{clearChat();input.focus();}');
    expect(widget).toContain('localStorage.removeItem(sessionKey)');
    expect(widget).toContain('clearInterval(expiryTimer)');
  });

  it('uses the clean blue-and-white visual palette', () => {
    expect(widget).toContain("color = '#1677ff'");
    expect(widget).toContain('background:#fff;color:#172033');
    expect(widget).toContain('background:#1677ff');
  });
});
