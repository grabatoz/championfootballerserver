import { QueryInterface, DataTypes } from 'sequelize';

export async function up(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('Matches');
  
  // Add archived column if not exists
  if (!table.archived) {
    await queryInterface.addColumn('Matches', 'archived', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  }
}


export async function down(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('Matches');
  
  // Remove archived column if exists
  if (table.archived) {
    await queryInterface.removeColumn('Matches', 'archived');
  }
}