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
    console.log('Checking Matches table columns...');
    const columns = await qi.describeTable('Matches');

    if (columns.removed) {
      console.log('✔ Matches.removed already exists. No action needed.');
      return;
    }

    console.log('Adding removed JSONB column to Matches...');
    await qi.addColumn('Matches', 'removed', {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: { home: [], away: [] },
      comment: 'Removed players by team side, e.g. { home: [userId], away: [userId] }',
    });

    console.log('✔ Added Matches.removed successfully.');
  } catch (err) {
    console.error('Failed to add Matches.removed:', err);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();