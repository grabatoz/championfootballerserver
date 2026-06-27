import { getUserLeagues } from '../controllers/leagueController.full';
import cache from '../utils/cache';

async function run() {
  try {
    const userId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';
    
    // Clear cache first
    const cacheKey = `user_leagues_${userId}`;
    cache.del(cacheKey);

    // Mock Koa context
    const ctx: any = {
      state: {
        user: { userId }
      },
      query: {
        refresh: '1'
      },
      set: (header: string, val: string) => {
        console.log(`Header set: ${header} = ${val}`);
      },
      status: 200,
      body: null
    };

    console.log("Calling getUserLeagues...");
    await getUserLeagues(ctx);

    console.log("\nResponse Status:", ctx.status);
    if (ctx.body && ctx.body.success) {
      console.log(`Leagues returned: ${ctx.body.leagues.length}`);
      ctx.body.leagues.forEach((l: any) => {
        console.log(`- League: "${l.name}" | Admin ID: ${l.adminId} | Admin Name: "${l.adminName}"`);
      });
    } else {
      console.log("Response body:", ctx.body);
    }

  } catch (err) {
    console.error("Error running test:", err);
  } finally {
    process.exit(0);
  }
}

run();
