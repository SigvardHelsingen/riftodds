"""A deliberately off-meta draft: one champion and a six-slot shopping list."""
import random

# Data Dragon doesn't attach its purchase-group catalogue to individual items.
# Keep these common exclusions together; picking across roles is intentionally allowed.
ITEM_FAMILIES = (
    frozenset((3033, 3036, 6694, 3302)),  # armor penetration
    frozenset((3135, 3137)),              # percent magic penetration
    frozenset((3053, 3156, 6673)),        # Lifeline
    frozenset((3074, 3748, 6631, 6698)),  # Hydra
    frozenset((3078, 3100, 3508, 6662)),  # Spellblade
    frozenset((3102, 3814)),              # spell shields
)
NO_BOOTS = frozenset((69,))  # Cassiopeia's passive forbids boots.


def roll(champions, items):
    """Return (champion_id, six item IDs), using only currently purchasable Rift items.

    This is a challenge build, not a recommendation or a purchase-order prediction.
    A shuffled, single-pass selection keeps work and memory bounded even with thin data.
    """
    if not champions:
        raise ValueError("Champion data is unavailable")
    champion = random.choice(tuple(champions))
    boots = [i for i, item in items.items() if item.get("random_eligible") and item.get("boots")]
    finished = [i for i, item in items.items() if item.get("random_eligible") and item.get("completed")
                and not item.get("boots") and not item.get("support")]
    needs_boots = champion not in NO_BOOTS
    if needs_boots and not boots:
        raise ValueError("Boot data is unavailable")
    needed = 5 if needs_boots else 6
    random.shuffle(finished)
    chosen, families, names = [], set(), set()
    for item_id in finished:
        groups = {index for index, family in enumerate(ITEM_FAMILIES) if item_id in family}
        name = items[item_id]["name"]
        if families & groups or name in names:
            continue
        chosen.append(item_id)
        families.update(groups)
        names.add(name)
        if len(chosen) == needed:
            break
    if len(chosen) != needed:
        raise ValueError("Not enough compatible items are available")
    return champion, ([random.choice(boots)] if needs_boots else []) + chosen
