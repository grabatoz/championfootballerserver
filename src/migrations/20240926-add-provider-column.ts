import { QueryInterface, DataTypes } from 'sequelize';

export async function up(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('users');
  
  // Add provider column if not exists
  if (!table.provider) {
    await queryInterface.addColumn('users', 'provider', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });
  }
  
  // Add providerId column if not exists
  if (!table.providerId) {
    await queryInterface.addColumn('users', 'providerId', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });
  }
}

export async function down(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('users');
  
  // Remove provider column if exists
  if (table.provider) {
    await queryInterface.removeColumn('users', 'provider');
  }
  
  // Remove providerId column if exists
  if (table.providerId) {
    await queryInterface.removeColumn('users', 'providerId');
  }
}