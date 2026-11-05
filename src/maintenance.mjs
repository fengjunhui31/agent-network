import { ROOT } from './paths.mjs';
import { networkVersion, buildId } from './version.mjs';

// Admission closes before observing activity. Existing conversations and their children may finish.
export class ReleaseGate {
  constructor(hold = false) {
    this.phase = hold ? 'holding' : 'open';
    this.admissions = 0;
    this.executions = new Set();
    this.channel = null;
  }
  status(network) {
    const info = this.channel?.activity() ?? null;
    const conversations = info?.conversations ?? 0;
    const deliveries = info?.deliveries ?? 0;
    const callbacks = info?.callbacks ?? 0;
    const ready = !info || info.initialized;
    const peerActivity=(network.federation?.transport.inflight??0)+(network.federation?.work.size??0)+Number(Boolean(network.federation?.hosts?.busy));
    return { protocol: 1, phase: this.phase, version: networkVersion, buildId, applicationRoot: ROOT,
      instanceRoot: network.root, activeRuns: [...this.executions], admissions: this.admissions,
      conversations, deliveries, callbacks, peerActivity, channel: info?.connection ?? null, channelInfo: info,
      readyToStop: this.phase !== 'open' && ready && !this.executions.size && !this.admissions
        && !peerActivity && !conversations && !deliveries && !callbacks };
  }
  command(action, network) {
    if (action === 'drain' && this.phase === 'open') this.phase = 'draining';
    else if (action === 'resume') {
      this.phase = 'open';
      this.channel?.resume();
      if(network.federation)void network.federation.recover().catch(e=>{network.federation.lastRecoveryError=e.message;});
    } else if (!['status', 'drain'].includes(action)) throw new Error('Unknown maintenance action');
    return this.status(network);
  }
}
