import { pool } from '../src/db/pool.js'
import { PRODUCT_CATEGORIES } from '../src/productCategories.js'

const ADDITIONAL_PRODUCTS = 2000
const INVENTORY_LOCATIONS = ['Online Warehouse', 'Mumbai Store', 'Bengaluru Store']
const STYLES = [
  'AeroStride', 'CloudPulse', 'UrbanMotion', 'FlexForm', 'TerraTrack',
  'NovaActive', 'Everyday Edit', 'Summit Line', 'Coastline', 'MetroCore',
  'SwiftMove', 'PureComfort', 'EdgeWorks', 'NorthStar', 'StudioCraft',
  'TrailBound', 'MotionLab', 'Lumen Select', 'PaceMaker', 'OpenRoad',
  'Daybreak', 'FormFirst', 'StreetReady', 'Essential Works', 'VividLife',
]
const COLORS = [
  'midnight navy', 'forest green', 'stone grey', 'warm sand', 'deep burgundy',
  'cloud white', 'cobalt blue', 'terracotta', 'charcoal black', 'sage',
]
const MATERIALS = [
  'recycled polyester', 'cotton blend', 'lightweight knit', 'durable canvas',
  'textured synthetic', 'soft-touch fabric', 'reinforced mesh', 'easy-care weave',
]
const FEATURES = [
  'everyday comfort and practical storage',
  'lightweight construction for daily use',
  'versatile styling for work and weekends',
  'durable materials with easy-care details',
  'a clean profile and comfortable fit',
  'thoughtful details for travel and commuting',
  'breathable comfort through changing seasons',
  'reliable performance for an active routine',
]
const BRANDS = {
  Footwear: ['Velocita', 'Pacer', 'StrideWorks', 'Northline', 'TerraForm', 'MoveWell', 'Urbanite', 'PaceCraft'],
  Topwear: ['Velocita', 'Rangsutra', 'Urbanite', 'Threadline', 'Dayform', 'Northline', 'Cotton House', 'Studio Wear'],
  Bottomwear: ['Urbanite', 'Threadline', 'Dayform', 'Denim Works', 'Northline', 'FormFirst', 'StreetFit', 'MoveWell'],
  Accessories: ['Auralis', 'Kinetix', 'Hearth', 'Sitwell', 'Wayfarer', 'CarryKind', 'Urbanite', 'Lumen Select'],
} satisfies Record<(typeof PRODUCT_CATEGORIES)[number], string[]>

const FAMILIES: Record<(typeof PRODUCT_CATEGORIES)[number], string[]> = {
  Footwear: [
    'Road Running Shoe', 'Trail Running Shoe', 'Walking Sneaker', 'Everyday Sneaker',
    'Training Cross-Trainer', 'Court Tennis Shoe', 'Basketball High-Top', 'Football Cleat',
    'Hiking Boot', 'Waterproof Trekking Shoe', 'Leather Derby Shoe', 'Formal Oxford Shoe',
    'Casual Loafer', 'Slip-On Canvas Shoe', 'High-Top Street Sneaker', 'Lightweight Gym Shoe',
    'Recovery Slide Sandal', 'Outdoor Sandal', 'School Lace-Up Shoe', 'Walking Slip-On',
  ],
  Topwear: [
    'Crew-Neck T-Shirt', 'Polo T-Shirt', 'Long-Sleeve Tee', 'Performance Tank Top',
    'Casual Button-Down Shirt', 'Formal Dress Shirt', 'Oxford Shirt', 'Linen Shirt',
    'Printed Resort Shirt', 'Denim Shirt', 'Pullover Hoodie', 'Zip-Up Hoodie',
    'Crew-Neck Sweatshirt', 'Lightweight Windcheater', 'Running Jacket', 'Rain Jacket',
    'Puffer Jacket', 'Cotton Kurta', 'Tunic Top', 'Thermal Base-Layer Top',
  ],
  Bottomwear: [
    'Slim-Fit Jeans', 'Straight-Fit Jeans', 'Relaxed-Fit Jeans', 'Tapered Chinos',
    'Classic Chinos', 'Cargo Trousers', 'Formal Trousers', 'Relaxed Linen Trousers',
    'Everyday Joggers', 'Training Joggers', 'Track Pants', 'Running Shorts',
    'Cotton Shorts', 'Denim Shorts', 'Pleated Skirt', 'A-Line Skirt',
    'Straight-Fit Skirt', 'Stretch Leggings', 'Athletic Leggings', 'Comfort Lounge Pants',
  ],
  Accessories: [
    'Wireless Headphones', 'True Wireless Earbuds', 'Fitness Smartwatch', 'Everyday Backpack',
    'Laptop Backpack', 'Canvas Tote Bag', 'Crossbody Sling Bag', 'Travel Duffel Bag',
    'Leather Belt', 'Polarized Sunglasses', 'Classic Analog Watch', 'Digital Sports Watch',
    'Insulated Water Bottle', 'Travel Coffee Mug', 'Compact Umbrella', 'Card Holder Wallet',
    'Wireless Charging Pad', 'Portable Power Bank', 'Desk Organizer', 'Yoga Mat',
  ],
}

type Category = keyof typeof FAMILIES

interface Product {
  product_id: string
  name: string
  brand: string
  category: Category
  price_inr: number
  sizes: string[]
  description: string
  rating: number
  return_window_days: number
}

function hash(value: string) {
  let result = 2166136261
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619) >>> 0
  return result
}

function makeProducts(ids: number[]): Product[] {
  const categories = [...PRODUCT_CATEGORIES] as Category[]
  const output: Product[] = []
  for (let index = 0; index < ids.length; index++) {
    const category = categories[index % categories.length]
    const ordinal = Math.floor(index / categories.length)
    const familyIndex = ordinal % FAMILIES[category].length
    const styleIndex = Math.floor(ordinal / FAMILIES[category].length)
    const style = STYLES[styleIndex % STYLES.length]
    const family = FAMILIES[category][familyIndex]
    const seed = hash(`${category}:${index}`)
    const color = COLORS[seed % COLORS.length]
    const material = MATERIALS[(seed >>> 4) % MATERIALS.length]
    const feature = FEATURES[(seed >>> 8) % FEATURES.length]
    const categorySizes: Record<Category, string[]> = {
      Footwear: ['6', '7', '8', '9', '10', '11'],
      Topwear: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
      Bottomwear: ['28', '30', '32', '34', '36', '38'],
      Accessories: [],
    }
    const priceRanges: Record<Category, [number, number]> = {
      Footwear: [1499, 14999],
      Topwear: [499, 6999],
      Bottomwear: [699, 8999],
      Accessories: [299, 49999],
    }
    const [minimum, maximum] = priceRanges[category]
    const electronicAccessory = category === 'Accessories'
      && /Headphones|Earbuds|Smartwatch|Analog Watch|Digital Sports Watch|Charging Pad|Power Bank/.test(family)
    output.push({
      product_id: `LUM-PRD-${String(ids[index]).padStart(4, '0')}`,
      name: `${style} ${family}`,
      brand: BRANDS[category][(seed >>> 12) % BRANDS[category].length],
      category,
      price_inr: minimum + ((seed >>> 16) % (maximum - minimum + 1)),
      sizes: categorySizes[category],
      description: `${family} in ${color}, made with ${material}. Designed for ${feature}.`,
      rating: Number((3.5 + ((seed >>> 20) % 15) / 10).toFixed(1)),
      return_window_days: electronicAccessory ? 10 : 30,
    })
  }
  return output
}

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lumen-expand-catalog-v1'))")
    const { rows: countRows } = await client.query<{ count: string }>('SELECT count(*) FROM products')
    const currentCount = Number(countRows[0].count)
    const targetCount = Math.max(2020, currentCount)
    const toAdd = targetCount - currentCount

    if (toAdd === 0) {
      await client.query('COMMIT')
      console.log(`Catalogue already contains ${currentCount} products; no rows added.`)
      return
    }

    await client.query(
      `SELECT setval(
         'product_seq',
         GREATEST(
           COALESCE((SELECT max(substring(product_id from '[0-9]+$')::bigint)
             FROM products WHERE product_id ~ '^LUM-PRD-[0-9]+$'), 0),
           (SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END FROM product_seq)
         ) + 1,
         false
       )`,
    )
    const { rows: sequenceRows } = await client.query<{ id: string }>(
      `SELECT nextval('product_seq') AS id
         FROM generate_series(1, $1)
        ORDER BY id`,
      [toAdd],
    )
    const products = makeProducts(sequenceRows.map(({ id }) => Number(id)))
    const productInsert = await client.query(
      `INSERT INTO products
         (product_id, name, brand, category, price_inr, sizes, description, rating, return_window_days)
       SELECT product_id, name, brand, category, price_inr, sizes, description, rating, return_window_days
         FROM jsonb_to_recordset($1::jsonb) AS p(
           product_id text, name text, brand text, category text, price_inr numeric,
           sizes text[], description text, rating numeric, return_window_days integer
         )`,
      [JSON.stringify(products)],
    )
    if (productInsert.rowCount !== products.length) throw new Error('Not all generated products were inserted')

    const inventory = products.flatMap((product) => {
      const sizes = product.sizes.length ? product.sizes : ['ONE']
      return sizes.flatMap((size) => INVENTORY_LOCATIONS.map((location) => ({
        product_id: product.product_id,
        size,
        location,
        quantity: hash(`${product.product_id}:${size}:${location}`) % 9,
      })))
    })
    const inventoryInsert = await client.query(
      `INSERT INTO inventory (product_id, size, location, quantity)
       SELECT product_id, size, location, quantity
         FROM jsonb_to_recordset($1::jsonb) AS i(
           product_id text, size text, location text, quantity integer
         )`,
      [JSON.stringify(inventory)],
    )
    if (inventoryInsert.rowCount !== inventory.length) throw new Error('Not all generated inventory rows were inserted')
    await client.query('COMMIT')
    console.log(`Added ${productInsert.rowCount} products and ${inventoryInsert.rowCount} inventory rows. Catalogue total: ${currentCount + productInsert.rowCount}.`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('[catalog:expand] failed to expand product catalogue', error)
  process.exitCode = 1
})
