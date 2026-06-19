import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import playersRouter from '../src/routes/players';

async function main() {
  const layer = playersRouter.stack.find((l) => l.path === '/players/:id/trophies' && l.methods.includes('GET'));
  if (!layer) {
    console.error('Could not find route matching /players/:id/trophies');
    return;
  }

  // Get the last middleware in the stack (the controller itself)
  const controller = layer.stack[layer.stack.length - 1];

  const ctx: any = {
    params: {
      id: 'a60adc4b-9054-453f-bc5b-af02e06fb4fe' // Use a sample playerId from the db
    },
    query: {
      leagueId: 'all',
      year: 'all',
      seasonId: 'all'
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
    console.log('Calling /players/:id/trophies controller...');
    const start = Date.now();
    await controller(ctx, async () => {});
    const end = Date.now();
    console.log(`\n--- Controller Response (Took ${end - start}ms) ---`);
    console.log('Status:', ctx.status || 200);
    console.log('Body keys:', Object.keys(ctx.body || {}));
    if (ctx.body && ctx.body.data) {
      console.log('Trophies counts:', JSON.stringify(ctx.body.data.counts || {}, null, 2));
    }
  } catch (err) {
    console.error('Controller crashed:', err);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
