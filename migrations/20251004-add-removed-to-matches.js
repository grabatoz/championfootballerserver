'use strict';
module.exports = {
  async up(qi, Sequelize) {
    await qi.sequelize.query(
      `ALTER TABLE "Matches"
       ADD COLUMN IF NOT EXISTS "removed" JSONB NOT NULL DEFAULT '{"home":[],"away":[]}'`
    );
  },
  
  async down(qi) {
    await qi.removeColumn('Matches', 'removed');
  }
};