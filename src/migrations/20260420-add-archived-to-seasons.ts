import { QueryInterface, DataTypes } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Seasons');
    if (!tableInfo['archived']) {
      await queryInterface.addColumn('Seasons', 'archived', {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      });
    }
  },
  down: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Seasons');
    if (tableInfo['archived']) {
      await queryInterface.removeColumn('Seasons', 'archived');
    }
  },
};
