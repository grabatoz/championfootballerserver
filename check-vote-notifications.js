const { Sequelize } = require('sequelize');
require('dotenv').config();

// Use environment variable for connection
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  protocol: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

async function checkVoteNotifications() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connected successfully\n');

    // Check for MOTM_VOTE notifications
    const notifications = await sequelize.query(
      `SELECT 
        n.id,
        n.user_id,
        n.type,
        n.title,
        n.body,
        n.meta,
        n.read,
        n.created_at,
        u."firstName" || ' ' || u."lastName" as recipient_name
      FROM notifications n
      LEFT JOIN users u ON u.id = n.user_id
      WHERE n.type = 'MOTM_VOTE'
      ORDER BY n.created_at DESC
      LIMIT 10`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    console.log(`📊 Found ${notifications.length} MOTM_VOTE notifications:\n`);

    if (notifications.length === 0) {
      console.log('❌ No MOTM_VOTE notifications found in database!');
      console.log('⚠️  This means the notification system is not working.\n');
      
      // Check if there are any votes at all
      const votes = await sequelize.query(
        `SELECT 
          v.id,
          v."matchId",
          v."voterId",
          v."votedForId",
          voter."firstName" || ' ' || voter."lastName" as voter_name,
          voted."firstName" || ' ' || voted."lastName" as voted_player_name,
          v.created_at
        FROM votes v
        LEFT JOIN users voter ON voter.id = v."voterId"
        LEFT JOIN users voted ON voted.id = v."votedForId"
        ORDER BY v.created_at DESC
        LIMIT 5`,
        { type: Sequelize.QueryTypes.SELECT }
      );

      console.log(`\n📋 Recent votes in database (${votes.length} found):`);
      votes.forEach((vote, index) => {
        console.log(`\n${index + 1}. Vote ID: ${vote.id}`);
        console.log(`   Match: ${vote.matchId}`);
        console.log(`   Voter: ${vote.voter_name} (${vote.voterId})`);
        console.log(`   Voted For: ${vote.voted_player_name} (${vote.votedForId})`);
        console.log(`   Created: ${vote.created_at}`);
      });
    } else {
      notifications.forEach((notif, index) => {
        console.log(`\n${index + 1}. Notification ID: ${notif.id}`);
        console.log(`   Recipient: ${notif.recipient_name} (${notif.user_id})`);
        console.log(`   Title: ${notif.title}`);
        console.log(`   Body: ${notif.body}`);
        console.log(`   Read: ${notif.read}`);
        console.log(`   Meta:`, notif.meta);
        console.log(`   Created: ${notif.created_at}`);
      });
    }

    // Check a recent vote for match players
    console.log('\n\n🔍 Checking a recent vote for match players...');
    const recentVote = await sequelize.query(
      `SELECT "matchId", "voterId", "votedForId", "createdAt" FROM "Votes" ORDER BY "createdAt" DESC LIMIT 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    if (recentVote.length > 0) {
      const matchId = recentVote[0].matchId;
      console.log(`\nMatch ID: ${matchId}`);

      // Get home team players
      const homePlayers = await sequelize.query(
        `SELECT u.id, u."firstName" || ' ' || u."lastName" as name
         FROM "UserHomeMatches" uhm
         LEFT JOIN users u ON u.id = uhm."userId"
         WHERE uhm."matchId" = :matchId`,
        { replacements: { matchId }, type: Sequelize.QueryTypes.SELECT }
      );

      // Get away team players
      const awayPlayers = await sequelize.query(
        `SELECT u.id, u."firstName" || ' ' || u."lastName" as name
         FROM "UserAwayMatches" uam
         LEFT JOIN users u ON u.id = uam."userId"
         WHERE uam."matchId" = :matchId`,
        { replacements: { matchId }, type: Sequelize.QueryTypes.SELECT }
      );

      console.log(`\n👥 Home Team Players (${homePlayers.length}):`);
      homePlayers.forEach(p => console.log(`   - ${p.name} (${p.id})`));

      console.log(`\n👥 Away Team Players (${awayPlayers.length}):`);
      awayPlayers.forEach(p => console.log(`   - ${p.name} (${p.id})`));

      const totalPlayers = homePlayers.length + awayPlayers.length;
      const excludedPlayers = 2; // voter and voted player
      const expectedNotifications = totalPlayers - excludedPlayers;

      console.log(`\n📊 Summary:`);
      console.log(`   Total players: ${totalPlayers}`);
      console.log(`   Excluded (voter + voted): ${excludedPlayers}`);
      console.log(`   Expected notifications: ${expectedNotifications}`);
      console.log(`   Actual notifications: ${notifications.length}`);

      if (notifications.length < expectedNotifications) {
        console.log('\n❌ MISMATCH! Notifications not sent to all players!');
      } else {
        console.log('\n✅ All notifications sent successfully!');
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await sequelize.close();
  }
}

checkVoteNotifications();
