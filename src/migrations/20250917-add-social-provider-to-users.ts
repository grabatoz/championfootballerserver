import { QueryInterface, DataTypes } from 'sequelize';

export default {
  async up(queryInterface: QueryInterface) {
    await queryInterface.addColumn('Users', 'provider', {
      type: DataTypes.STRING,
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Users', 'provider');
  },
};