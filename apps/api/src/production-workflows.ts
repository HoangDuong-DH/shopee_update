import type { Repository, BlobStore } from '@shopee/persistence';
import { ProductionBatchService } from './production-batch-service.js';
import { ProductionBatchReviewService } from './production-batch-review-service.js';
import { ProductionPreparationService } from './production-preparation-service.js';
import { ProductionPreparationExecution } from './production-preparation-execution.js';
import { ProductionPreparationAutofillService } from './production-preparation-autofill.js';
import { ProductionPreparationMetadataService } from './production-preparation-metadata.js';
import { bindProductionService, selectedProductionScope, productionOwner, legacyProductionScope } from './production-scope.js';

export type ProductionWorkflow = {
  batch: ProductionBatchService; review: ProductionBatchReviewService;
  preparation: ProductionPreparationService; execution: ProductionPreparationExecution;
  autofill: ProductionPreparationAutofillService; metadata: ProductionPreparationMetadataService;
};

/** One instance graph per shop: promises, polling caches and admission gates cannot
 * be shared across shops. DB journals remain the durable source of truth. */
export class ProductionWorkflows {
  private readonly shops = new Map<string, ProductionWorkflow>();
  constructor(private readonly repo: Repository, private readonly blobs: BlobStore,
    private readonly legacy: ProductionWorkflow) {}
  get(raw: unknown): ProductionWorkflow {
    const scope = selectedProductionScope(raw), owner = productionOwner(scope);
    const cached = this.shops.get(owner);
    if(cached) return cached;
    // Bound admission rather than evicting a graph that may still own active work.
    if(this.shops.size >= 1000) throw Error('PRODUCTION_BATCH_SCOPE_CAPACITY');
    let services = this.legacy;
    if(owner !== productionOwner(legacyProductionScope)) {
      const batch = new ProductionBatchService(this.repo,this.blobs);
      const preparation = new ProductionPreparationService(this.repo,this.blobs);
      services = {batch, preparation,
        review: new ProductionBatchReviewService(this.repo,this.blobs),
        execution: new ProductionPreparationExecution(this.repo,preparation,batch),
        autofill: new ProductionPreparationAutofillService(this.repo),
        metadata: new ProductionPreparationMetadataService(this.repo)};
    }
    const bound = Object.fromEntries(Object.entries(services).map(([key,value]) =>
      [key,bindProductionService(scope,value)])) as ProductionWorkflow;
    this.shops.set(owner,bound);
    return bound;
  }
}
