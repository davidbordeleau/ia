# Product authoring

Install `inventarch/product-structure`, with its exact `inventarch/language` dependency, before you author a `@product`. Read the [`@product` schema guide](schemas/product.SPEC.md) and the [product architecture](SPEC.md) first.

Author each `@product` in a system of your own that requires `product-system`. Point `owner` at a real local `@agent` and `plans` at real local `@plan` records. Then run generic native admission and the product reader, `readProduct` from `consumer.mjs`. Admission may only warn about a dangling reference; the reader refuses it, along with a `format` other than `1`, a blank title and a repeated plan. Keep both archive identities pinned in the consumer's `.ia/distributions.lock.json`.

To extend products, add a separate local system with explicit references. Editing the installed schema and registering `@product` a second time are unsupported, and the distribution carries no grants. `owner` is not authenticated membership, and `retired` deletes or revokes nothing.

This guide declares how to author a product. It does not show that an agent reading it for the first time will author one correctly.
