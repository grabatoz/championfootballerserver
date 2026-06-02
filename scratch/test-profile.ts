import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import { getPlayerProfile } from '../src/controllers/playerController';

async function main() {
  const ctx: any = {
    params: {
      id: 'a60adc4b-9054-453f-bc5b-af02e06fb4fe' // Ru Uddin user ID
    },
    query: {
      leagueId: 'all',
      year: 'all'
    },
    state: {
      user: {
        userId: 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'
      }
    },
    set(name: string, value: string) {
      console.log(`[Header] ${name}: ${value}`);
    },
    throw(status: number, message: string) {
      const err = new Error(message) as any;
      err.status = status;
      throw err;
    }
  };

  try {
    console.log('Calling getPlayerProfile...');
    await getPlayerProfile(ctx);
    console.log('\n--- Controller Response ---');
    console.log('Status:', ctx.status || 200);
    console.log('Body data leagues count:', ctx.body?.data?.leagues?.length);
    console.log('Body sample leagues keys:', Object.keys(ctx.body?.data || {}));
  } catch (err) {
    console.error('Controller crashed:', err);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
