import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import playersRouter from '../src/routes/players';

async function main() {
  const layer = playersRouter.stack.find((l) => l.path === '/players/:id/profile' && l.methods.includes('GET'));
  if (!layer) {
    console.error('Could not find route matching /players/:id/profile');
    return;
  }

  const controller = layer.stack[layer.stack.length - 1];

  const ctx: any = {
    params: {
      id: 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'
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
    set(name: string, value: string) {},
    throw(status: number, message: string) {
      throw new Error(message);
    }
  };

  console.log('--- Run 1 (Cold cache, should query DB) ---');
  let t = Date.now();
  await controller(ctx, async () => {});
  console.log(`Run 1 took: ${Date.now() - t}ms`);

  console.log('\n--- Run 2 (Warm cache, should HIT cache instantly) ---');
  t = Date.now();
  await controller(ctx, async () => {});
  console.log(`Run 2 took: ${Date.now() - t}ms`);

  console.log('\n--- Run 3 (Warm cache, should HIT cache instantly) ---');
  t = Date.now();
  await controller(ctx, async () => {});
  console.log(`Run 3 took: ${Date.now() - t}ms`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
