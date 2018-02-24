/*
    global Booking, ContractService, Listing, ListingAvailability, ListingTypeService, ModelSnapshot, PricingService,
    StelaceConfigService, TimeService, User
 */

module.exports = {

    createBooking,
    getAvailabilityPeriods,
    getAvailabilityDates,

};

var moment = require('moment');
const _ = require('lodash');
const createError = require('http-errors');

/**
 * Create booking based on user input
 * @param  {Object} user
 * @param  {Number} listingId
 * @param  {String} [startDate]
 * @param  {Number} [nbTimeUnits]
 * @param  {Number} listingTypeId
 * @param  {Number} [quantity = 1]
 * @return {Object}
 */
async function createBooking({
    user,
    listingId,
    startDate,
    nbTimeUnits,
    listingTypeId,
    quantity = 1,
}) {
    if (! listingId
        || !listingTypeId
    ) {
        throw createError(400);
    }

    const now = moment().toISOString();

    const [
        listing,
        listingTypes,
    ] = await Promise.all([
        Listing.findOne({ id: listingId }),
        ListingTypeService.getListingTypes(),
    ]);

    if (! listing) {
        throw createError(404);
    }

    checkBasic({
        listing,
        user,
        listingTypeId,
    });

    const listingType = _.find(listingTypes, type => type.id === listingTypeId);
    if (!listingType) {
        throw createError(404);
    }

    const config = await StelaceConfigService.getConfig();
    const paymentProvider = config.paymentProvider;

    let bookingAttrs = {
        listingId: listing.id,
        ownerId: listing.ownerId,
        takerId: user.id,
        autoAcceptance: listing.autoBookingAcceptance,
        contractId: ContractService.getContractId(),
        listingTypeId: listingType.id,
        listingType: listingType,
        paymentProvider,
    };

    bookingAttrs = await setBookingTimePeriods({
        bookingAttrs,
        listing,
        listingType,
        startDate,
        nbTimeUnits,
    });

    bookingAttrs = await setBookingAvailability({
        bookingAttrs,
        listing,
        listingType,
        startDate,
        endDate: bookingAttrs.endDate,
        quantity,
        now,
    });

    bookingAttrs = await setBookingPrices({
        bookingAttrs,
        listing,
        listingType,
        user,
        nbTimeUnits,
        quantity: bookingAttrs.quantity,
        now,
    });

    const listingSnapshot = await ModelSnapshot.getSnapshot('listing', listing);
    bookingAttrs.listingSnapshotId = listingSnapshot.id;

    if (bookingAttrs.autoAcceptance) {
        bookingAttrs.acceptedDate = now;
    }

    const booking = await Booking.create(bookingAttrs);
    return booking;
}

function checkBasic({
    listing,
    user,
    listingTypeId,
}) {
    if (listing.ownerId === user.id) {
        throw createError(403, 'Owner cannot book its own listing');
    }
    if (!listing.listingTypesIds.length) {
        throw new Error('Listing has no listing types');
    }
    if (!listingTypeId || !_.includes(listing.listingTypesIds, listingTypeId)) {
        throw new Error('Incorrect listing type');
    }
    if (!listing.quantity) {
        throw new Error('Not enough quantity');
    }
    if (!listing.validated) { // admin validation needed
        throw createError(400, 'Not validated');
    }

    const bookable = Listing.isBookable(listing);
    if (! bookable) {
        throw createError(400, 'Listing not bookable');
    }
}

async function setBookingTimePeriods({
    bookingAttrs,
    listing,
    listingType,
    startDate,
    nbTimeUnits,
}) {
    const { TIME } = listingType.properties;

    if (TIME === 'TIME_FLEXIBLE') {
        if (!startDate || !nbTimeUnits) {
            throw createError(400);
        }

        const timeUnit = listingType.config.bookingTime.timeUnit;

        const validDates = Booking.isValidDates({
            startDate,
            nbTimeUnits,
            refDate: moment().format('YYYY-MM-DD') + 'T00:00:00.000Z',
            config: listingType.config.bookingTime,
            canOmitDuration: false,
        });

        if (!validDates.result) {
            throw createError(400, 'Invalid dates');
        }

        const endDate = Booking.computeEndDate({
            startDate,
            nbTimeUnits,
            timeUnit,
        });

        _.assign(bookingAttrs, {
            startDate,
            endDate,
            nbTimeUnits,
            timeUnit,
            deposit: listing.deposit,
            timeUnitPrice: listing.dayOnePrice,
            currency: 'EUR', // TODO: allow to set other currencies
            pricingId: listing.pricingId,
            customPricingConfig: listing.customPricingConfig,
        });
    } else if (TIME === 'TIME_PREDEFINED') {
        if (!startDate) {
            throw createError(400);
        }

        const timeUnit = listingType.config.bookingTime.timeUnit;

        const validDates = Booking.isValidDates({
            startDate,
            refDate: moment().format('YYYY-MM-DD') + 'T00:00:00.000Z',
            config: listingType.config.bookingTime,
            canOmitDuration: true,
        });

        if (!validDates.result) {
            throw createError(400, 'Invalid date');
        }

        let validPredefinedDate = true;
        let isDateInRecurringList = false;

        const listingAvailability = await ListingAvailability.findOne({
            listingId: listing.id,
            startDate,
            type: 'date',
        });

        if (listing.reccuringDatesPattern) {
            const recurringDates = TimeService.computeRecurringDates(listing.reccuringDatesPattern, {
                startDate: moment(startDate).add({ d: -1 }).toISOString(),
                endDate: moment(startDate).add({ d: 1 }).toISOString(),
            });

            isDateInRecurringList = _.includes(recurringDates, startDate);
        }

        validPredefinedDate = !!listingAvailability || isDateInRecurringList;

        if (!validPredefinedDate) {
            throw createError(400, 'The booking date is not in the predefined list');
        }

        _.assign(bookingAttrs, {
            startDate,
            timeUnit,
            currency: 'EUR', // TODO: allow to set other currencies
        });
    }

    return bookingAttrs;
}

async function setBookingAvailability({
    bookingAttrs,
    listing,
    listingType,
    startDate,
    endDate,
    quantity,
    now,
}) {
    const { TIME, AVAILABILITY } = listingType.properties;
    const { timeAvailability } = listingType.config;

    const maxQuantity = Listing.getMaxQuantity(listing, listingType);

    if (AVAILABILITY === 'NONE') {
        bookingAttrs.quantity = 1;
    } else if (AVAILABILITY === 'UNIQUE') {
        if (maxQuantity < quantity) {
            throw createError(400, 'Do not have enough quantity');
        }

        bookingAttrs.quantity = 1;
    } else {
        if (TIME === 'TIME_FLEXIBLE') {
            if (maxQuantity < quantity) {
                throw createError(400, 'Do not have enough quantity');
            }

            const futureBookings = await Listing.getFutureBookings(listing.id, now);

            let listingAvailabilities;
            if (timeAvailability === 'AVAILABLE' || timeAvailability === 'UNAVAILABLE') {
                listingAvailabilities = await ListingAvailability.find({
                    listingId: listing.id,
                    type: 'period',
                });
            }

            const availability = getAvailabilityPeriods({
                futureBookings,
                listingAvailabilities,
                newBooking: {
                    startDate,
                    endDate,
                    quantity,
                },
                maxQuantity,
            });

            if (!availability.isAvailable) {
                throw createError(400, 'Not available');
            }
        } else if (TIME === 'TIME_PREDEFINED') {
            const futureBookings = await Listing.getFutureBookings(listing.id, now);

            let listingAvailabilities;
            listingAvailabilities = await ListingAvailability.find({
                listingId: listing.id,
                type: 'date',
            });

            const availability = getAvailabilityDates({
                futureBookings,
                listingAvailabilities,
                newBooking: {
                    startDate,
                    quantity,
                },
                maxQuantity,
            });

            if (!availability.isAvailable) {
                throw createError(400, 'Not available');
            }
        }

        bookingAttrs.quantity = quantity;
    }

    return bookingAttrs;
}

async function setBookingPrices({
    bookingAttrs,
    listing,
    listingType,
    user,
    nbTimeUnits,
    quantity,
    now,
}) {
    const owner = await User.findOne({ id: listing.ownerId });
    if (!owner) {
        throw createError('Owner not found');
    }

    const {
        ownerFeesPercent,
        takerFeesPercent,
        ownerFreeFees,
        takerFreeFees,
    } = await getFeesValues({
        owner,
        taker: user,
        pricing: listingType.config.pricing,
        now,
    });
    const maxDiscountPercent = listingType.config.pricing.maxDiscountPercent;

    const {
        ownerPrice,
        freeValue,
        discountValue,
    } = await getOwnerPriceValue({
        listingType,
        listing,
        nbTimeUnits,
        quantity,
    });

    var priceResult = PricingService.getPriceAfterRebateAndFees({
        ownerPrice: ownerPrice,
        freeValue: freeValue,
        ownerFeesPercent: ownerFeesPercent,
        takerFeesPercent: takerFeesPercent,
        discountValue: discountValue,
        maxDiscountPercent: maxDiscountPercent
    });

    bookingAttrs.priceData = {
        freeValue,
        discountValue,
        ownerFreeFees,
        takerFreeFees,
    };

    bookingAttrs.ownerFees  = priceResult.ownerFees;
    bookingAttrs.takerFees  = priceResult.takerFees;
    bookingAttrs.ownerPrice = ownerPrice;
    bookingAttrs.takerPrice = priceResult.takerPrice;

    return bookingAttrs;
}

async function getFeesValues({ owner, taker, pricing, now }) {
    const ownerFreeFees = User.isFreeFees(owner, now);
    const takerFreeFees = User.isFreeFees(taker, now);

    const ownerFeesPercent = ! ownerFreeFees ? pricing.ownerFeesPercent : 0;
    const takerFeesPercent = ! takerFreeFees ? pricing.takerFeesPercent : 0;

    return {
        ownerFreeFees,
        takerFreeFees,
        ownerFeesPercent,
        takerFeesPercent,
    };
}

async function getOwnerPriceValue({ listingType, listing, nbTimeUnits, quantity = 1 }) {
    let ownerPrice;
    let discountValue;
    let freeValue;

    if (listingType.properties.TIME === 'TIME_FLEXIBLE') {
        const prices = PricingService.getPrice({
            config: listing.customPricingConfig || PricingService.getPricing(listing.pricingId).config,
            dayOne: listing.dayOnePrice,
            nbDays: nbTimeUnits,
            custom: !! listing.customPricingConfig,
            array: true
        });
        ownerPrice    = prices[nbTimeUnits - 1];
        discountValue = 0;
        freeValue     = 0;
    } else {
        ownerPrice    = listing.sellingPrice;
        freeValue     = 0;
        discountValue = 0;
    }

    return {
        ownerPrice: ownerPrice * quantity,
        freeValue,
        discountValue,
    };
}

/**
 * Check if the listing is available compared to future bookings and stock availability
 * @param  {Object[]} [futureBookings]
 * @param  {String} futureBookings[i].startDate
 * @param  {String} futureBookings[i].endDate
 * @param  {Number} futureBookings[i].quantity
 * @param  {Object[]} [listingAvailabilities]
 * @param  {String} listingAvailabilities[i].startDate
 * @param  {String} listingAvailabilities[i].endDate
 * @param  {Boolean} listingAvailabilities[i].available
 * @param  {Number} listingAvailabilities[i].quantity
 * @param  {Object} [newBooking]
 * @param  {String} newBooking.startDate
 * @param  {String} newBooking.endDate
 * @param  {Number} newBooking.quantity
 * @param  {Number} [maxQuantity] - if not defined, treat it as no limit
 *
 * @return {Object} res
 * @return {Boolean} res.isAvailable
 * @return {Object[]} res.availablePeriods
 * @return {String} res.availablePeriods[i].date
 * @return {Number} res.availablePeriods[i].quantity - represents the quantity used at this date
 * @return {String} [res.availablePeriods[i].newPeriod] - 'start' or 'end', represents the limits of the new booking if provided
 */
function getAvailabilityPeriods({ futureBookings = [], listingAvailabilities = [], newBooking, maxQuantity } = {}) {
    const dateSteps = [];

    _.forEach(futureBookings, booking => {
        dateSteps.push({
            date: booking.startDate,
            delta: booking.quantity,
        });

        dateSteps.push({
            date: booking.endDate,
            delta: -booking.quantity,
        });
    });

    _.forEach(listingAvailabilities, listingAvailability => {
        const startSign = listingAvailability.available ? -1 : 1; // if available, one extra place so -1
        const endSign = -1 * startSign;

        dateSteps.push({
            date: listingAvailability.startDate,
            delta: startSign * listingAvailability.quantity,
        });

        dateSteps.push({
            date: listingAvailability.endDate,
            delta: endSign * listingAvailability.quantity,
        });
    });

    if (newBooking) {
        dateSteps.push({
            date: newBooking.startDate,
            delta: newBooking.quantity,
            newPeriod: 'start',
        });

        dateSteps.push({
            date: newBooking.endDate,
            delta: -newBooking.quantity,
            newPeriod: 'end',
        });
    }

    const sortedSteps = _.sortBy(dateSteps, step => step.date);

    const availablePeriods = [];
    let quantity = 0;
    let oldStep;
    let currStep;
    let isAvailable = true;

    _.forEach(sortedSteps, step => {
        quantity += step.delta;

        currStep = {
            date: step.date,
            quantity,
        };

        if (isAvailable && newBooking && typeof maxQuantity === 'number' && currStep.quantity > maxQuantity) {
            isAvailable = false;
        }

        if (step.newPeriod) {
            currStep.newPeriod = step.newPeriod;
        }

        if (oldStep && currStep.date === oldStep.date) {
            oldStep.quantity = quantity;
        } else {
            availablePeriods.push(currStep);
            oldStep = currStep;
        }
    });

    if (availablePeriods.length) {
        const firstStep = availablePeriods[0];
        availablePeriods.unshift({
            date: moment(firstStep.date).subtract({ d: 1 }).toISOString(),
            quantity: 0,
        });
    }

    return {
        isAvailable,
        availablePeriods,
    };
}

/**
 * Check if the listing is available compared to future bookings and stock availability
 * @param  {Object[]} [futureBookings]
 * @param  {String} futureBookings[i].startDate
 * @param  {Number} futureBookings[i].quantity
 * @param  {Object[]} [listingAvailabilities]
 * @param  {String} listingAvailabilities[i].startDate
 * @param  {Number} listingAvailabilities[i].quantity
 * @param  {Object} [newBooking]
 * @param  {String} newBooking.startDate
 * @param  {Number} newBooking.quantity
 * @param  {Number} [maxQuantity] - if not defined, treat it as no limit
 *
 * @return {Object} res
 * @return {Boolean} res.isAvailable
 * @return {Object[]} res.availableDates
 * @return {String} res.availableDates[i].date
 * @return {Number} res.availableDates[i].quantity - represents the quantity used at this date
 * @return {Boolean} [res.availableDates[i].selected] - if defined, show that this date is from the new booking
 */
function getAvailabilityDates({ futureBookings = [], listingAvailabilities = [], newBooking, maxQuantity } = {}) {
    const dateSteps = {};

    _.forEach(futureBookings, booking => {
        let dateStep = dateSteps[booking.startDate];
        if (!dateStep) {
            dateStep = {
                date: booking.startDate,
                quantity: 0,
            };
            dateSteps[booking.startDate] = dateStep;
        }

        dateStep.quantity += booking.quantity;
    });

    if (newBooking) {
        let dateStep = dateSteps[newBooking.startDate];
        if (!dateStep) {
            dateStep = {
                date: newBooking.startDate,
                quantity: 0,
            };
            dateSteps[newBooking.startDate] = dateStep;
        }

        dateStep.quantity += newBooking.quantity;
        dateStep.selected = true;
    }

    let isAvailable = true;
    const availableDates = _.sortBy(_.values(dateSteps), 'date');
    const exposedListingAvailabilities = listingAvailabilities.map(listingAvailability => {
        return _.pick(listingAvailability, ['startDate', 'quantity']);
    })

    const indexedListingAvailabilities = _.indexBy(listingAvailabilities, 'startDate');

    let currentMaxQuantity;
    if (newBooking && typeof maxQuantity === 'number') {
        currentMaxQuantity = maxQuantity;

        const listingAvailability = indexedListingAvailabilities[newBooking.startDate];
        if (listingAvailability) {
            currentMaxQuantity = listingAvailability.quantity;
        }
    }

    if (newBooking && typeof currentMaxQuantity === 'number' && dateSteps[newBooking.startDate].quantity > currentMaxQuantity) {
        isAvailable = false;
    }

    return {
        isAvailable,
        listingAvailabilities: exposedListingAvailabilities,
        availableDates,
    };
}
