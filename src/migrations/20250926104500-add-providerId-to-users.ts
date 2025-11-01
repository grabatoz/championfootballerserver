import { QueryInterface, DataTypes } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    // Only add if missing (idempotent safety)
    const desc = await queryInterface.describeTable('users');
    if (!desc.providerId) {
      await queryInterface.addColumn('users', 'providerId', {
        type: DataTypes.STRING,
        allowNull: true
      });
      
      // Optional composite uniqueness (uncomment if needed)
      // await queryInterface.addIndex('users', ['provider', 'providerId'], {
      //   name: 'users_provider_providerId_unique',
      //   unique: true,
      //   where: {
      //     provider: { [ (DataTypes as any).Op.ne ]: null },
      //     providerId: { [ (DataTypes as any).Op.ne ]: null }
      //   }
      // });
    }
  },

  down: async (queryInterface: QueryInterface) => {
    const desc = await queryInterface.describeTable('users');
    if (desc.providerId) {
      await queryInterface.removeColumn('users', 'providerId');
    }
    // await queryInterface.removeIndex('users', 'users_provider_providerId_unique').catch(()=>{});
  }
};