export const PRODUCT_CATEGORIES = ['Footwear', 'Topwear', 'Bottomwear', 'Accessories'] as const

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

export function isProductCategory(value: unknown): value is ProductCategory {
  return PRODUCT_CATEGORIES.some((category) => category === value)
}
