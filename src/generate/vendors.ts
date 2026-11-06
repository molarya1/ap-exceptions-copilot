import type { Rng } from '../lib/prng';
import type { Category, Vendor } from './model';

// Every name here is invented. Domains use the reserved .example TLD so nothing can collide
// with a real company, and bank accounts use an obviously synthetic QF-TEST format.

interface VendorSeed {
  key: string; // stable handle used by the scenarios
  legalName: string;
  tradingNames?: string[];
  category: Category;
  terms: string;
  domain: string;
  currency?: string;
  status?: 'inactive';
}

export const VENDOR_SEEDS: VendorSeed[] = [
  // growers
  { key: 'brightwater', legalName: 'Brightwater Growers LLC', category: 'growers', terms: 'NET30', domain: 'brightwatergrowers.example' },
  { key: 'calder', legalName: 'Calder Valley Dairy Co', category: 'growers', terms: 'NET30', domain: 'caldervalleydairy.example' },
  { key: 'juniper', legalName: 'Juniper Hill Orchards Inc', category: 'growers', terms: '2/10 NET30', domain: 'juniperhill.example' },
  { key: 'saskatoon', legalName: 'Saskatoon Prairie Growers Ltd', category: 'growers', terms: 'NET30', domain: 'prairiegrowers.example', currency: 'CAD' },
  { key: 'marrow', legalName: 'Marrow Creek Farms LLC', category: 'growers', terms: '2/10 NET30', domain: 'marrowcreek.example' },
  { key: 'ashgrove', legalName: 'Ashgrove Produce Co', tradingNames: ['Ashgrove Fresh'], category: 'growers', terms: 'NET30', domain: 'ashgroveproduce.example' },
  { key: 'linden', legalName: 'Linden Bend Farms Inc', category: 'growers', terms: 'NET30', domain: 'lindenbend.example' },
  { key: 'copperfield', legalName: 'Copperfield Citrus LLC', category: 'growers', terms: 'NET30', domain: 'copperfieldcitrus.example' },
  { key: 'hollis', legalName: 'Hollis Mushroom Farm Inc', category: 'growers', terms: 'NET30', domain: 'hollismushroom.example' },
  { key: 'reddmesa', legalName: 'Redd Mesa Onion Co', category: 'growers', terms: 'NET30', domain: 'reddmesa.example' },
  { key: 'wren', legalName: 'Wren Hollow Greens LLC', category: 'growers', terms: 'NET30', domain: 'wrenhollow.example' },
  { key: 'tolland', legalName: 'Tolland Egg Farm Inc', category: 'growers', terms: 'NET30', domain: 'tollandeggs.example' },
  // packaging
  { key: 'harlow', legalName: 'Harlow Packaging Ltd', category: 'packaging', terms: 'NET30', domain: 'harlowpackaging.example' },
  { key: 'kestrel', legalName: 'Kestrel Box & Carton Inc', category: 'packaging', terms: '2/10 NET30', domain: 'kestrelbox.example' },
  { key: 'mardale', legalName: 'Mardale Films & Wraps LLC', category: 'packaging', terms: 'NET30', domain: 'mardalefilms.example' },
  { key: 'pinecrest', legalName: 'Pinecrest Labels Co', category: 'packaging', terms: '2/10 NET30', domain: 'pinecrestlabels.example' },
  { key: 'sutter', legalName: 'Sutter Pallet Works Inc', category: 'packaging', terms: 'NET30', domain: 'sutterpallet.example' },
  { key: 'oakhurst', legalName: 'Oakhurst Containers Inc', category: 'packaging', terms: 'NET45', domain: 'oakhurstcontainers.example' },
  // freight and storage
  { key: 'ostrander', legalName: 'Ostrander Freight Lines Inc', category: 'freight', terms: 'NET30', domain: 'ostranderfreight.example' },
  { key: 'fenwick', legalName: 'Fenwick Cold Storage LLC', category: 'freight', terms: 'NET30', domain: 'fenwickcold.example' },
  { key: 'bellamy', legalName: 'Bellamy Reefer Transport Inc', category: 'freight', terms: 'NET30', domain: 'bellamyreefer.example' },
  { key: 'greyling', legalName: 'Greyling Logistics LLC', category: 'freight', terms: '2/10 NET30', domain: 'greylinglogistics.example' },
  { key: 'coastline', legalName: 'Coastline LTL Co', category: 'freight', terms: 'NET30', domain: 'coastlineltl.example' },
  { key: 'ridgeway', legalName: 'Ridgeway Haulage Inc', category: 'freight', terms: 'NET30', domain: 'ridgewayhaulage.example' },
  // equipment service
  { key: 'pellhart', legalName: 'Pell & Hart Equipment Service LLC', tradingNames: ['Pell and Hart'], category: 'equipment_service', terms: 'NET30', domain: 'pellhart.example' },
  { key: 'vettori', legalName: 'Vettori Refrigerazione S.r.l.', category: 'equipment_service', terms: 'NET45', domain: 'vettori-refrigerazione.example', currency: 'EUR' },
  { key: 'dunmore', legalName: 'Dunmore Forklift Service Inc', category: 'equipment_service', terms: 'NET30', domain: 'dunmoreforklift.example' },
  { key: 'castellan', legalName: 'Castellan Electric Co', category: 'equipment_service', terms: 'NET45', domain: 'castellanelectric.example' },
  { key: 'halverson', legalName: 'Halverson Facility Services LLC', category: 'equipment_service', terms: 'NET30', domain: 'halversonfacility.example' },
  // utilities (no purchase orders)
  { key: 'larchmont', legalName: 'Larchmont Power & Light', category: 'utilities', terms: 'NET15', domain: 'larchmontpower.example' },
  { key: 'tamsin', legalName: 'Tamsin County Water', category: 'utilities', terms: 'NET15', domain: 'tamsinwater.example' },
  { key: 'northgate', legalName: 'Northgate Waste Services Inc', category: 'utilities', terms: 'NET30', domain: 'northgatewaste.example' },
  { key: 'brandt', legalName: 'Brandt Telecom LLC', category: 'utilities', terms: 'NET30', domain: 'brandttelecom.example' },
  // no longer used
  { key: 'oldmill', legalName: 'Old Mill Packaging Co', category: 'packaging', terms: 'NET30', domain: 'oldmillpackaging.example', status: 'inactive' },
  { key: 'ferris', legalName: 'Ferris Produce LLC', category: 'growers', terms: 'NET30', domain: 'ferrisproduce.example', status: 'inactive' },
];

const FIRST = ['Maren', 'Tobias', 'Ines', 'Callum', 'Priya', 'Desmond', 'Hollis', 'Yara', 'Emmett', 'Saoirse', 'Jonah', 'Lucia', 'Rafael', 'Noor', 'Wendell', 'Ottilie', 'Bram', 'Celeste', 'Idris', 'Margit'];
const LAST = ['Ashby', 'Quill', 'Okafor', 'Lindqvist', 'Varga', 'Prentice', 'Halloran', 'Sato', 'Bergstrom', 'Mbeki', 'Castell', 'Duarte', 'Ferrante', 'Kowalczyk', 'Rourke', 'Thistle', 'Vance', 'Whitcombe'];

export function syntheticAccount(rng: Rng): string {
  return `QF-TEST-${String(rng.int(0, 9999)).padStart(4, '0')}-${String(rng.int(0, 9999)).padStart(4, '0')}`;
}

export function buildVendors(rng: Rng): Map<string, Vendor> {
  const vendors = new Map<string, Vendor>();
  const usedNames = new Set<string>();
  const usedPhones = new Set<number>();
  VENDOR_SEEDS.forEach((seed, i) => {
    let contactName = '';
    do contactName = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    while (usedNames.has(contactName));
    usedNames.add(contactName);
    let phone = 0;
    do phone = rng.int(100, 199);
    while (usedPhones.has(phone));
    usedPhones.add(phone);
    const first = contactName.split(' ')[0]!.toLowerCase();
    vendors.set(seed.key, {
      id: `V${String(i + 1).padStart(3, '0')}`,
      legalName: seed.legalName,
      tradingNames: seed.tradingNames ?? [],
      category: seed.category,
      terms: seed.terms,
      remitAccount: syntheticAccount(rng),
      contactName,
      // 555-01XX numbers are reserved for fiction.
      contactPhone: `(${rng.pick(['209', '559', '916', '831'])}) 555-0${phone}`,
      contactEmail: `${first}@${seed.domain}`,
      domain: seed.domain,
      currency: seed.currency ?? 'USD',
      status: seed.status ?? 'active',
    });
  });
  return vendors;
}

export const BUYERS = ['Rosa Delgado', 'Arjun Malhotra', 'Dana Pryce'];
