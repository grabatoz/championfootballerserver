import { QueryInterface, DataTypes } from 'sequelize';

export async function up(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('users');
  if (!table.provider) {
    await queryInterface.addColumn('users', 'provider', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });
  }
}

export async function down(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('users');
  if (table.provider) {
    await queryInterface.removeColumn('users', 'provider');
  }
}