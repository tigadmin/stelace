/* global ApiService, Listing, ListingService, Media */

module.exports = {

    find,
    findOne,
    create,
    update,
    destroy,
    getPricing,
    validate,
    updateMedias,

};

async function find(req, res) {
    const attrs = req.allParams();
    const sortFields = [
        'id',
        'name',
        'description',
        'validated',
        'locked',
        'sellingPrice',
        'deposit',
        'createdDate',
    ];
    const searchFields = [
        'id',
        'name',
        'description',
    ];

    const access = 'api';

    try {
        const fields = ApiService.parseFields(attrs);
        const pagination = ApiService.parsePagination(attrs);
        const populateMedia = _.includes(fields, 'media');

        const sorting = ApiService.parseSorting(attrs, sortFields);
        const searchAttrs = ApiService.parseSearchQuery(attrs, searchFields);

        const fetchListings = () => {
            if (pagination) {
                return Listing.find(searchAttrs).sort(sorting).paginate(pagination);
            } else {
                return Listing.find(searchAttrs).sort(sorting);
            }
        };

        let [
            listings,
            countListings,
        ] = await Promise.all([
            fetchListings(),
            Listing.count(searchAttrs),
        ]);

        const hashMedias = populateMedia ? await Listing.getMedias(listings) : {};

        listings = _.map(listings, listing => {
            const exposedListing = Listing.expose(listing, access);
            if (populateMedia) {
                exposedListing.medias = Media.exposeAll(hashMedias[listing.id], access);
            }
            return exposedListing;
        });

        const returnedObj = ApiService.getPaginationMeta({
            totalResults: countListings,
            limit: pagination && pagination.limit,
            allResults: !pagination,
        });
        returnedObj.results = listings;

        res.json(returnedObj);
    } catch (err) {
        res.sendError(err);
    }
}

async function findOne(req, res) {
    const id = req.param('id');
    const attrs = req.allParams();
    const access = 'api';

    try {
        const fields = ApiService.parseFields(attrs);
        const populateMedia = _.includes(fields, 'media');

        const listing = await Listing.findOne({ id });
        if (!listing) {
            throw new NotFoundError();
        }

        const exposedListing = Listing.expose(listing, access);

        if (populateMedia) {
            const hashMedias = await Listing.getMedias([listing]);
            exposedListing.medias = Media.exposeAll(hashMedias[listing.id], access);
        }

        res.json(exposedListing);
    } catch (err) {
        res.sendError(err);
    }
}

async function create(req, res) {
    const attrs = req.allParams();

    const access = 'api';

    try {
        const listing = await ListingService.createListing(attrs, { req, res });
        res.json(Listing.expose(listing, access));
    } catch (err) {
        res.sendError(err);
    }
}

async function update(req, res) {
    const id = req.param('id');
    const attrs = req.allParams();

    const access = 'api';

    try {
        const listing = await ListingService.updateListing(id, attrs);
        res.json(Listing.expose(listing, access));
    } catch (err) {
        res.sendError(err);
    }
}

async function destroy(req, res) {
    const id = req.param('id');

    try {
        await ListingService.destroyListing(id, {
            keepCommittedBookings: false,
            trigger: 'admin',
        }, { req, res });

        res.json({ id });
    } catch (err) {
        res.sendError(err);
    }
}

async function getPricing(req, res) {
    const pricingId = req.param('pricingId');

    try {
        const pricing = ListingService.getPricing(pricingId);
        res.json(pricing);
    } catch (err) {
        res.sendError(err);
    }
}

async function validate(req, res) {
    const id = req.param('id');

    const access = 'api';

    try {
        const listing = await ListingService.validateListing(id);
        res.json(Listing.expose(listing, access));
    } catch (err) {
        res.sendError(err);
    }
}

async function updateMedias(req, res) {
    const id = req.param('id');
    const mediasIds = req.param('mediasIds');
    const mediaType = req.param('mediaType');

    try {
        await ListingService.updateListingMedias(id, { mediasIds, mediaType });
        res.json({ id });
    } catch (err) {
        res.sendError(err);
    }
}
