'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add JSONB column with default { home: [], away: [] }
    await queryInterface.sequelize.query(`
      ALTER TABLE "Matches"
      ADD COLUMN IF NOT EXISTS "removed" JSONB NOT NULL DEFAULT '{"home":[],"away":[]}'
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Matches', 'removed');
  }
};