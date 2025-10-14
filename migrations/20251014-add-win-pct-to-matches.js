'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Matches', 'homeWinPct', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('Matches', 'awayWinPct', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Matches', 'awayWinPct');
    await queryInterface.removeColumn('Matches', 'homeWinPct');
  }
};
