import React, { useEffect, useState } from 'react';
import { api, fmtAgo } from '../api.js';
import { useSession } from '../App.jsx';
import { CredentialSelect } from './ParamForm.jsx';

const CHANNELS = {
  email: { label: 'Email', type: 'smtp', target: 'Send to', placeholder: 'you@example.com', help: 'Uses your mail server connection (Gmail app password, Mailgun, and so on). Separate several addresses with commas.' },
  slack: { label: 'Slack', type: 'slackApi', target: 'Channel', placeholder: '#alerts', help: 'Invite your bot to the channel first: type /invite @yourbot there.' },
  telegram: { label: 'Telegram', type: 'telegramApi', target: 'Chat ID', placeholder: '123456789', help: 'A number. Send your bot a message first so it may write to you. Not sure what your ID is? Message @userinfobot in Telegram.' },
};

/** "Tell me if this fails": one setting block for the workflow settings panel. */
export default function AlertSettings({ workflowId, alerts, onChange, credentials, reloadCredentials }) {
  const { me } = useSession();
  const a = alerts ?? { enabled: false, channel: 'email', credentialId: '', to: '' };
  const ch = CHANNELS[a.channel] ?? CHANNELS.email;
  const [test, setTest] = useState(null); // { busy } | { ok, message }
  const [status, setStatus] = useState(null);
  const set = (patch) => { setTest(null); onChange({ ...a, ...patch }); };

  useEffect(() => {
    if (!a.enabled) { setStatus(null); return; }
    api(`/workflows/${workflowId}/alerts/status`).then(setStatus).catch(() => setStatus(null));
  }, [workflowId, a.enabled]);

  const turnOn = (enabled) => set({ enabled, ...(enabled && !a.to && a.channel === 'email' ? { to: me?.user?.email ?? '' } : {}) });
  const pickChannel = (channel) => set({ channel, credentialId: '', to: channel === 'email' ? (me?.user?.email ?? '') : '' });
  const ready = !!a.credentialId && !!a.to.trim();

  const sendTest = async () => {
    setTest({ busy: true });
    try { setTest(await api(`/workflows/${workflowId}/alerts/test`, { method: 'POST', body: { alerts: a } })); } catch (e) { setTest({ ok: false, message: e.message }); }
  };

  return (
    <div className="stack tight alert-settings">
      <h4>Tell me if this fails</h4>
      <label className="inline switch">
        <input type="checkbox" checked={!!a.enabled} onChange={(e) => turnOn(e.target.checked)} />
        <span>Send me a message when a run fails</span>
      </label>
      {a.enabled && (
        <>
          <label>Send it by
            <select value={a.channel} onChange={(e) => pickChannel(e.target.value)}>
              {Object.entries(CHANNELS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
            </select>
          </label>
          <label>Connection
            <CredentialSelect
              key={a.channel} prop={{ required: true, credentialType: ch.type }} value={a.credentialId} values={{}}
              onChange={(id) => set({ credentialId: id })} credentials={credentials} reloadCredentials={reloadCredentials}
            />
          </label>
          <label>{ch.target}
            <input value={a.to} placeholder={ch.placeholder} onChange={(e) => set({ to: e.target.value })} />
            <span className="muted small">{ch.help}</span>
          </label>
          <div className="row gap wrap">
            <button type="button" onClick={sendTest} disabled={!ready || test?.busy}>{test?.busy ? 'Sending…' : 'Send a test alert'}</button>
            {test && !test.busy && <span className={`test-result ${test.ok ? 'ok' : 'bad'}`} role="status">{test.message}</span>}
          </div>
          {status?.lastError && <p className="error small">The last alert could not be sent: {status.lastError}</p>}
          {status?.lastSent && !status.lastError && <p className="muted small">Last alert sent {fmtAgo(status.lastSent)}{status.held ? `, and ${status.held} more held back` : ''}.</p>}
          <p className="muted small">You get at most one message every 10 minutes for this workflow; the next one says how many were held back. Runs you start in the editor do not send alerts.</p>
        </>
      )}
    </div>
  );
}
