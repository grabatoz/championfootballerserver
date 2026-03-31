import { QueryInterface, DataTypes } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Seasons');
    if (!tableInfo['trophyAwardSnapshot']) {
      await queryInterface.addColumn('Seasons', 'trophyAwardSnapshot', {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: {},
      });
    }
  },
  down: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Seasons');
    if (tableInfo['trophyAwardSnapshot']) {
      await queryInterface.removeColumn('Seasons', 'trophyAwardSnapshot');
    }
  },
};

