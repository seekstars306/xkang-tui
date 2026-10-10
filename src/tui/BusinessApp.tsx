import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { answerText, REVIEW_LABELS, type PublicSession } from '@xkang/agent-core/public';
import { BusinessClient } from '../adapters/business_client.js';
import { BusinessSessions } from '../config/business_sessions.js';
import { saveUserLocalConfig } from '../config/user_config.js';
import { KeyBindingPrompt } from './components/KeyBindingPrompt.js';
import { extractImagesFromInput } from '../utils/image.js';

export function BusinessApp({ serverUrl, token: initialToken }: { serverUrl: string; token?: string }) {
  const { exit } = useApp();
  const [token, setToken] = useState(initialToken), [input, setInput] = useState('');
  const [session, setSession] = useState<PublicSession | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const client = useMemo(() => new BusinessClient(serverUrl, token || ''), [serverUrl, token]);
  const cache = useMemo(() => new BusinessSessions(), []);
  useEffect(() => () => cache.close(), [cache]);
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => {
      if (session?.status !== 'idle' && session) void client.get(session.id).then(value => { cache.save(value); setSession(value); }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [client, session?.id, session?.status, token]);
  if (!token) return <KeyBindingPrompt serverUrl={serverUrl} onExit={exit} onActivated={value => { saveUserLocalConfig({ serverUrl, token: value }); setToken(value); }} />;
  const submit = async (value: string) => {
    if (!value.trim()) return;
    if (value === '/exit') { exit(); return; }
    const running = busy || Boolean(session && session.status !== 'idle');
    if (value === '/clear' && !running) { setSession(null); setInput(''); return; }
    if (running && !session?.pendingQuestion) return;
    setInput('');
    if (session?.pendingQuestion) { await client.answer(session.id, session.pendingQuestion.id, value); setSession(await client.get(session.id)); return; }
    setBusy(true);
    try {
      if (!(await cache.migrate(client)).complete) { setNotice('历史会话迁移未完成，请连接业务服务后重试。'); return; }
      const current = session || await client.create(); setSession({ ...current, status: 'running' });
      const images = extractImagesFromInput(value);
      await client.chat(current.id, images.hasImages ? images.parts : value, event => {
        if (event.type === 'progress') setNotice(event.phase === 'checking' ? '正在核对业务记录' : '正在复核业务结论');
        if (event.type === 'question') void client.get(current.id).then(setSession);
        if (event.type === 'error') setNotice(event.message);
      });
      const result = await client.get(current.id); cache.save(result); setSession(result); setNotice('');
    } catch { setNotice('连接暂时中断。输入新问题重试，或在网页端查看会话。'); }
    finally { setBusy(false); }
  };
  return <Box flexDirection="column">
    <Text bold color="cyan">小康业务助手 · /clear 新建会话 · /exit 退出</Text>
    {session?.turns.map(turn => <Box key={turn.id} flexDirection="column" marginY={1}>
      <Text color="green">{turn.userText}</Text>
      {turn.answer && <><Text color="cyan">{REVIEW_LABELS[turn.answer.reviewStatus]}</Text><Text>{answerText(turn.answer)}</Text></>}
    </Box>)}
    {session?.pendingQuestion?.questions.map((q, i) => <Text key={i} color="yellow">{q.question}</Text>)}
    <Text color="gray">{notice}</Text>
    <TextInput value={input} onChange={setInput} onSubmit={value => { void submit(value).catch(() => setNotice('补充信息未提交成功，请重试。')); }} />
  </Box>;
}
