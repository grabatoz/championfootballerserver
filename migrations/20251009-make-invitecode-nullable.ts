import { QueryInterface, DataTypes } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.changeColumn('Leagues', 'inviteCode', {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  });
}


export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.changeColumn('Leagues', 'inviteCode', {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  });
}