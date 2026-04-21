import { QueryInterface, DataTypes } from 'sequelize';

export async function up(queryInterface: QueryInterface) {
  const tableInfo = await queryInterface.describeTable('Matches');
  if (!tableInfo['deleted']) {
    await queryInterface.addColumn('Matches', 'deleted', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  }
}

export async function down(queryInterface: QueryInterface) {
  const tableInfo = await queryInterface.describeTable('Matches');
  if (tableInfo['deleted']) {
    await queryInterface.removeColumn('Matches', 'deleted');
  }
}

