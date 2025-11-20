import sequelize from '../config/database';
import { realtime } from './realtime';

// Minimal Postgres LISTEN/NOTIFY bridge using existing sequelize pool.
// Root-level solution: any NOTIFY from DB (including triggers or hooks) is pushed to SSE clients.

let started = false;
export async function startDbEventBridge() {
  if (started) return;
  started = true;
  try {
    // Acquire a dedicated connection for LISTEN (won't be released)
    const connection: any = await (sequelize as any).connectionManager.getConnection();

    const listenChannels = [
      'match_updates',
      'league_updates',
      'vote_updates',
      'stats_updates'
    ];
    for (const ch of listenChannels) {
      await connection.query(`LISTEN ${ch}`);
    }

    connection.on('notification', (msg: any) => {
      try {
        const channel = msg.channel;
        const payloadText = msg.payload || '{}';
        let payload: any = {};
        try { payload = JSON.parse(payloadText); } catch {}
        // Map channel to SSE event name
        const eventMap: Record<string,string> = {
          match_updates: 'match-updated',
          league_updates: 'league-updated',
          vote_updates: 'vote-updated',
          stats_updates: 'match-stats-updated'
        };
        const evt = eventMap[channel];
        if (evt) {
          realtime.broadcast(evt, payload);
        }
      } catch (e) {
        console.warn('[DBEvents] notification handling failed:', e);
      }
    });

    console.log('[DBEvents] LISTEN started on channels:', listenChannels.join(', '));
  } catch (e) {
    console.error('[DBEvents] Failed to start LISTEN bridge:', e);
  }
}
