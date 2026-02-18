module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add maxGames column to Seasons table
    await queryInterface.addColumn('Seasons', 'maxGames', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    // Add showPoints column to Seasons table
    await queryInterface.addColumn('Seasons', 'showPoints', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Remove maxGames column
    await queryInterface.removeColumn('Seasons', 'maxGames');

    // Remove showPoints column
    await queryInterface.removeColumn('Seasons', 'showPoints');
  }
};
