import { QueryInterface, DataTypes } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Seasons');
    if (!tableInfo['deleted']) {
      await queryInterface.addColumn('Seasons', 'deleted', {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      });
    }
  },
  down: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Seasons');
    if (tableInfo['deleted']) {
      await queryInterface.removeColumn('Seasons', 'deleted');
    }
  },
};
