import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module.js';
import { ProductsRepository } from './products.repository.js';

@Module({
  imports: [CommonModule],
  providers: [ProductsRepository],
  exports: [ProductsRepository],
})
export class SourceModule {}
