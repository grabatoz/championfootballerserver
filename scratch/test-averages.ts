import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import { getLeaguePlayerAverages } from '../src/controllers/leagueController.full';

async function main() {
  const ctx: any = {
    params: {
      id: '560f68b4-86f9-49be-b60f-f5391f7b26e4' // Season 7 FNF League ID
    },
    query: {
      seasonId: 'all',
      year: 'all'
    },
    state: {
      user: {
        userId: 'a60adc4b-9054-453f-bc5b-af02e06fb4fe' // Ru Uddin user ID
      }
    },
    set(name: string, value: string) {
      console.log(`[Header] ${name}: ${value}`);
    }
  };

  try {
    console.log('Calling getLeaguePlayerAverages...');
    await getLeaguePlayerAverages(ctx);
    console.log('\n--- Controller Response ---');
    console.log('Status:', ctx.status || 200);
    console.log('Body:', JSON.stringify(ctx.body, null, 2));
  } catch (err) {
    console.error('Controller crashed:', err);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
