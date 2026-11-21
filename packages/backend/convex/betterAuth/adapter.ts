import { createApi } from '@convex-dev/better-auth';

import { staticAuthOptions } from '../authOptions';
import schema from './schema';

export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany, consumeOne, incrementOne } = createApi(schema, staticAuthOptions);
