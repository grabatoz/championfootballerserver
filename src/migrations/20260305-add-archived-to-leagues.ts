import { QueryInterface, DataTypes } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    const tableInfo = await queryInterface.describeTable('Leagues');
    if (!tableInfo['archived']) {
      await queryInterface.addColumn('Leagues', 'archived', {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      });
    }
  },
  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn('Leagues', 'archived');
  },
};
