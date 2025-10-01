import { QueryInterface, DataTypes } from 'sequelize';

export async function up(q: QueryInterface) {
  await q.addColumn('matches', 'status', { type: DataTypes.ENUM('SCHEDULED','IN_PROGRESS','RESULT_UPLOADED','REVISION_REQUESTED','RESULT_PUBLISHED'), defaultValue: 'SCHEDULED' });
  await q.addColumn('matches', 'homeCaptainConfirmed', { type: DataTypes.BOOLEAN, defaultValue: false });
  await q.addColumn('matches', 'awayCaptainConfirmed', { type: DataTypes.BOOLEAN, defaultValue: false });
  await q.addColumn('matches', 'resultUploadedAt', { type: DataTypes.DATE, allowNull: true });
  await q.addColumn('matches', 'resultPublishedAt', { type: DataTypes.DATE, allowNull: true });
  await q.addColumn('matches', 'suggestedHomeGoals', { type: DataTypes.INTEGER, allowNull: true });
  await q.addColumn('matches', 'suggestedAwayGoals', { type: DataTypes.INTEGER, allowNull: true });
  await q.addColumn('matches', 'suggestedByCaptainId', { type: DataTypes.UUID, allowNull: true });
}

export async function down(q: QueryInterface) {
  await q.removeColumn('matches', 'status');
  await q.removeColumn('matches', 'homeCaptainConfirmed');
  await q.removeColumn('matches', 'awayCaptainConfirmed');
  await q.removeColumn('matches', 'resultUploadedAt');
  await q.removeColumn('matches', 'resultPublishedAt');
  await q.removeColumn('matches', 'suggestedHomeGoals');
  await q.removeColumn('matches', 'suggestedAwayGoals');
  await q.removeColumn('matches', 'suggestedByCaptainId');
}