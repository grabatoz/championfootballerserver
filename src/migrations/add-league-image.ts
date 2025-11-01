import { QueryInterface, DataTypes } from 'sequelize';

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn('Leagues', 'image', {
      type: DataTypes.STRING,
      allowNull: true,
    });
  },
  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn('Leagues', 'image');
  },
}; 
