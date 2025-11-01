import { Sequelize, DataTypes } from 'sequelize';
import models from '../models';

async function main() {
  const sequelize = (models.Match as any).sequelize as Sequelize;
  if (!sequelize) {
    console.error('Sequelize instance not found on models.Match.sequelize');
    process.exit(1);
    return;
  }
  const qi = sequelize.getQueryInterface();

  try {
    console.log('Checking Matches table columns for win pct...');
    const columns = await qi.describeTable('Matches');


    
    if (!columns.homeWinPct) {
      console.log('Adding homeWinPct (INTEGER, NULLABLE) to Matches...');
      await qi.addColumn('Matches', 'homeWinPct', {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Predicted home win percentage'
      });
      console.log('✔ Added Matches.homeWinPct');
    } else {
      console.log('✔ Matches.homeWinPct already exists');
    }

    if (!columns.awayWinPct) {
      console.log('Adding awayWinPct (INTEGER, NULLABLE) to Matches...');
      await qi.addColumn('Matches', 'awayWinPct', {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Predicted away win percentage'
      });
      console.log('✔ Added Matches.awayWinPct');
    } else {
      console.log('✔ Matches.awayWinPct already exists');
    }

    console.log('All set.');
  } catch (err) {
    console.error('Failed to ensure win pct columns on Matches:', err);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();
