import { UPDATE_KINGDOM, UPDATE_SELECTION, CLEAR_SELECTION } from "./mutation-types";
import { RANDOMIZE, RANDOMIZE_FULL_KINGDOM } from "./action-types";
import {EventTracker} from "../../analytics/event-tracker";
import {EventType} from "../../analytics/event-tracker";
import { State } from "./randomizer-store";
import {deserializeKingdom} from "../../randomizer/serializer";
import { ActionContext } from "vuex";
import { CardType } from "../../dominion/card-type";
import { RandomizerOptionsBuilder } from "../../randomizer/randomizer-options";
import { Cards } from "../../utils/cards";
import { Randomizer } from "../../randomizer/randomizer";
import { Kingdom } from "../../models/kingdom";
import { Card } from "../../dominion/card";
import { Supply } from "../../models/supply";
import { DominionSets } from "../../dominion/dominion-sets";
import { SupplyCard } from "../../dominion/supply-card";
import { SelectionParams } from "./selection";

interface Context extends ActionContext<State, any> {}

export const actions = {
  LOAD_INITIAL_KINGDOM(context: Context) {
    const kingdomFromUrl = deserializeKingdom(location.search);
    if (kingdomFromUrl) {
      // Use the kingdom as-is if it contains 10 supply cards.
      if (kingdomFromUrl.supply.supplyCards.length == 10) {
        EventTracker.trackEvent(EventType.LOAD_FULL_KINGDOM_FROM_URL);
        context.commit(UPDATE_KINGDOM, kingdomFromUrl);
        return;
      }
      // Randomize the rest of the set if there are less than 10 cards.
      const options =
          createRandomizerOptionsBuilder(context)
              .setSetIds(getSelectedSetIds(context))
              .setExcludeTypes(getExcludeTypes(context))
              .setIncludeCardIds(Cards.extractIds(kingdomFromUrl.supply.supplyCards))
              .build();
        
      const supply = Randomizer.createSupplySafe(options);
      if (supply) {
        EventTracker.trackEvent(EventType.LOAD_PARTIAL_KINGDOM_FROM_URL);
        const kingdom = new Kingdom(
            Date.now(), supply, kingdomFromUrl.events, kingdomFromUrl.landmarks,
            kingdomFromUrl.projects, kingdomFromUrl.metadata);
        context.commit(CLEAR_SELECTION);
        context.commit(UPDATE_KINGDOM, kingdom);
        return;
      } else {
        EventTracker.trackError(EventType.LOAD_PARTIAL_KINGDOM_FROM_URL);
      }
    }

    // Do a full randomize since we failed to retrieve a kingdom from the URL.
    context.dispatch(RANDOMIZE);
  },

  RANDOMIZE(context: Context) {
    const selectedCards = getSelectedSupplyCards(context);
    const isAddonSelected = 
        getSelectedEvents(context).length ||
        getSelectedLandmarks(context).length ||
        getSelectedProjects(context).length;
    
    if (!selectedCards.length && !isAddonSelected) {
      context.dispatch(RANDOMIZE_FULL_KINGDOM);
      return;
    }
    
    const oldSupply = context.state.kingdom.supply;
    const newSupply = selectedCards.length 
        ? randomizeSelectedCards(context) || oldSupply
        : oldSupply;
    const newAddons = isAddonSelected ? randomizeSelectedAddons(context) : null;
    const newEvents = newAddons
        ? Cards.getAllEvents(newAddons)
        : getSelectedEvents(context);
    const newLandmarks = newAddons
        ? Cards.getAllLandmarks(newAddons)
        : getSelectedLandmarks(context);
    const newProjects = newAddons
        ? Cards.getAllProjects(newAddons)
        : getSelectedProjects(context);
        
    const kingdom = new Kingdom(
      context.state.kingdom.id, newSupply, newEvents, newLandmarks, newProjects,
      context.state.kingdom.metadata);
    context.commit(CLEAR_SELECTION);
    context.commit(UPDATE_KINGDOM, kingdom);
  },

  RANDOMIZE_FULL_KINGDOM(context: Context) {
    const setIds = getSelectedSetIds(context);
    if (!setIds.length) {
      return;
    }

    const options = createRandomizerOptionsBuilder(context)
      .setSetIds(setIds)
      .setExcludeCardIds(getCardsToExclude(context))
      .setExcludeTypes(getExcludeTypes(context))
      .build();

    try {
      const kingdom = Randomizer.createKingdom(options);
      context.commit(CLEAR_SELECTION);
      context.commit(UPDATE_KINGDOM, kingdom);
      EventTracker.trackEvent(EventType.RANDOMIZE_KINGDOM);
    } catch (e) {
      EventTracker.trackError(EventType.RANDOMIZE_KINGDOM);
    }
  },

  SELECT_CARD(context: Context, id: string) {
    if (context.state.selection.contains(id)) {
      return;
    }
    const selection = context.state.selection;
    const card = DominionSets.getCardById(id);
    if (card instanceof SupplyCard) {
      context.commit(UPDATE_SELECTION, {
        selectedSupplyIds: selection.selectedSupplyIds.concat([id])
      } as SelectionParams) ;
    } else {
      context.commit(UPDATE_SELECTION, {
        selectedAddonIds: selection.selectedAddonIds.concat([id]) 
      } as SelectionParams);
    }
  },

  UNSELECT_CARD(context: Context, id: string) {
    if (!context.state.selection.contains(id)) {
      return;
    }
    const selection = context.state.selection;
    const card = DominionSets.getCardById(id);
    const filterFn = (existingId: string) => existingId != id;
    if (card instanceof SupplyCard) {
      context.commit(UPDATE_SELECTION, {
        selectedSupplyIds: selection.selectedSupplyIds.filter(filterFn)
      } as SelectionParams);
    } else {
      context.commit(UPDATE_SELECTION, {
        selectedAddonIds: selection.selectedAddonIds.filter(filterFn)
      } as SelectionParams);
    }
  }
}

function randomizeSelectedCards(context: Context): Supply | null {
  const options = createRandomizerOptionsBuilder(context)
      .setSetIds(getSelectedSetIds(context))
      .setIncludeCardIds(getUnselectedSupplyCards(context).map((card) => card.id))
      .setExcludeCardIds(getSelectedSupplyCards(context).map((card) => card.id))
      .setExcludeTypes(getExcludeTypes(context))
      .build();

  const supply = Randomizer.createSupplySafe(options);
  if (supply) {
    EventTracker.trackEvent(EventType.RANDOMIZE_MULTIPLE);
  } else {
    EventTracker.trackError(EventType.RANDOMIZE_MULTIPLE);
  }
  return supply;
}

function randomizeSelectedAddons(context: Context) {
  const selectedAddonIds =
      getSelectedEvents(context)
          .map((card) => card.id)
          .concat(
              getSelectedLandmarks(context).map((card) => card.id),
              getSelectedProjects(context).map((card) => card.id));
  const newAddonsCount = selectedAddonIds.length;

  // TODO: Include undefined addons (allow selected card back)
  
  EventTracker.trackEvent(EventType.RANDOMIZE_EVENTS_AND_LANDMARKS);
  return Randomizer.getRandomAddons(getSelectedSetIds(context), selectedAddonIds, newAddonsCount);
}

function createRandomizerOptionsBuilder(context: Context) {
  const randomizerSettings = context.state.settings.randomizerSettings;
  return new RandomizerOptionsBuilder()
      .setRequireActionProvider(randomizerSettings.requireActionProvider)
      .setRequireBuyProvider(randomizerSettings.requireBuyProvider)
      .setRequireTrashing(randomizerSettings.requireTrashing)
      .setRequireReactionIfAttacks(randomizerSettings.requireReaction)
      .setDistributeCost(
          context.getters.isDistributeCostAllowed && randomizerSettings.distributeCost)
      .setPrioritizeSet(
          context.getters.isPrioritizeSetAllowed
              ? randomizerSettings.prioritizeSet
              : null);
}

function getCardsToExclude(context: Context) {
  // Only exclude cards when at least 3 sets are selected and no sets are prioritized.
  if (context.state.settings.randomizerSettings.prioritizeSet) {
    return [];
  } 
  const setIds = getSelectedSetIds(context);
  return setIds.length >= 3
      ? getSelectedSupplyCards(context).map((card) => card.id)
      : []; 
}


function getSelectedSetIds(context: Context) {
  return context.state.settings.selectedSets;
}

function getExcludeTypes(context: Context): CardType[] {
  return context.state.settings.randomizerSettings.allowAttacks ? [] : [CardType.ATTACK];
}

function getSelectedSupplyCards(context: Context) {
  return getSelected(context, context.state.kingdom.supply.supplyCards);
}

function getUnselectedSupplyCards(context: Context) {
  const selection = context.state.selection;
  const cards = context.state.kingdom.supply.supplyCards;
  return cards.filter((card) => !selection.contains(card.id));
}

function getSelectedEvents(context: Context) {
  return getSelected(context, context.state.kingdom.events);
}

function getSelectedLandmarks(context: Context) {
  return getSelected(context, context.state.kingdom.landmarks);
}

function getSelectedProjects(context: Context) {
  return getSelected(context, context.state.kingdom.projects);
}

function getSelected<T extends Card>(context: Context, cards: T[]) {
  const selection = context.state.selection;
  return cards.filter((card) => selection.contains(card.id));
}
