// Standalone tests for the three-finger tab scrub math. The model has no
// Chromium dependencies, so it is built on its own:
//   scripts/test-tab-scrub-model.sh
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>

#include "chrome/browser/ui/views/helium/helium_tab_scrub_model.h"

using helium::ScrubPosition;
using helium::SwipeAxisLock;

static int failures = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("FAIL line %d: %s\n", __LINE__, #cond);              \
      ++failures;                                                      \
    }                                                                  \
  } while (0)
#define NEAR(a, b) CHECK(std::abs((a) - (b)) < 1e-9)

int main() {
  using Axis = SwipeAxisLock::Axis;
  {  // Tiny motion does not choose an axis.
    SwipeAxisLock lock;
    CHECK(lock.Add(3, 2) == Axis::kUndecided);
    CHECK(lock.Add(-2, 1) == Axis::kUndecided);
    CHECK(lock.TakeCarry() == 0.0);
  }
  {  // Vertical wins and keeps the travel that arrived first.
    SwipeAxisLock lock;
    CHECK(lock.Add(1, 5) == Axis::kUndecided);
    CHECK(lock.Add(2, 10) == Axis::kVertical);
    NEAR(lock.TakeCarry(), 15.0);
    NEAR(lock.TakeCarry(), 0.0);  // only once
  }
  {  // Horizontal, negative.
    SwipeAxisLock lock;
    CHECK(lock.Add(-20, 3) == Axis::kHorizontal);
    NEAR(lock.TakeCarry(), -20.0);
  }
  {  // The axis never changes once chosen.
    SwipeAxisLock lock;
    CHECK(lock.Add(0, 30) == Axis::kVertical);
    CHECK(lock.Add(500, 0) == Axis::kVertical);
  }
  {  // Non-finite input is ignored.
    SwipeAxisLock lock;
    CHECK(lock.Add(std::nan(""), 5) == Axis::kUndecided);
    CHECK(lock.Add(std::numeric_limits<double>::infinity(), 0) ==
          Axis::kUndecided);
    CHECK(lock.Add(0, 20) == Axis::kVertical);
  }

  {  // Starts on the active item and moves continuously.
    ScrubPosition p(10, 4, 30.0);
    NEAR(p.position(), 4.0);
    CHECK(p.NearestIndex() == 4);
    p.Move(15.0);  // half an item
    NEAR(p.position(), 4.5);
    CHECK(p.FloorIndex() == 4);
    NEAR(p.Fraction(), 0.5);
    p.Move(6.0);  // 4.7 -> nearest 5
    CHECK(p.NearestIndex() == 5);
    p.Move(-60.0);  // 2.7 -> nearest 3
    CHECK(p.NearestIndex() == 3);
    NEAR(p.position(), 2.7);
  }
  {  // Many small frames equal one big move: there are no steps.
    ScrubPosition a(20, 0, 30.0), b(20, 0, 30.0);
    for (int i = 0; i < 300; ++i) a.Move(0.5);
    b.Move(150.0);
    NEAR(a.position(), b.position());
    NEAR(a.position(), 5.0);
  }
  {  // Stops at both ends, never wraps.
    ScrubPosition p(5, 3, 20.0);
    p.Move(10000.0);
    NEAR(p.position(), 4.0);
    CHECK(p.NearestIndex() == 4);
    CHECK(p.FloorIndex() == 4);
    NEAR(p.Fraction(), 0.0);
    p.Move(-10000.0);
    NEAR(p.position(), 0.0);
    CHECK(p.NearestIndex() == 0);
  }
  {  // Reversing mid-gesture returns to the same place.
    ScrubPosition p(8, 2, 25.0);
    p.Move(80.0);
    p.Move(-80.0);
    NEAR(p.position(), 2.0);
    CHECK(p.NearestIndex() == p.start_index());
  }
  {  // Bad input cannot corrupt the position.
    ScrubPosition p(8, 2, 25.0);
    p.Move(std::nan(""));
    p.Move(std::numeric_limits<double>::infinity());
    NEAR(p.position(), 2.0);
  }
  {  // Degenerate construction is clamped.
    ScrubPosition p(0, 9, 0.0);
    CHECK(p.count() == 1);
    CHECK(p.start_index() == 0);
    p.Move(100.0);
    CHECK(p.NearestIndex() == 0);
    ScrubPosition q(3, -4, 10.0);
    CHECK(q.start_index() == 0);
  }
  {  // Lifting the fingers lands exactly on the nearest item.
    ScrubPosition p(6, 1, 20.0);
    p.Move(33.0);  // 2.65
    p.SnapToNearest();
    NEAR(p.position(), 3.0);
    CHECK(p.FloorIndex() == 3);
    NEAR(p.Fraction(), 0.0);
  }
  {  // Halfway rounds up, so landing is deterministic.
    ScrubPosition p(4, 1, 10.0);
    p.Move(5.0);
    CHECK(p.NearestIndex() == 2);
  }
  {  // Longer strips need more finger travel per tab, within bounds.
    double previous = 0;
    for (int n = 0; n <= 80; ++n) {
      const double t = ScrubPosition::TravelPerTab(n);
      CHECK(t >= previous);
      CHECK(t >= 28.0 && t <= 64.0);
      previous = t;
    }
    NEAR(ScrubPosition::TravelPerTab(1000), ScrubPosition::TravelPerTab(40));
  }
  {  // A full touchpad sweep (about 500 DIPs) crosses a useful number of tabs.
    ScrubPosition few(8, 0, ScrubPosition::TravelPerTab(8));
    few.Move(500.0);
    CHECK(few.NearestIndex() == 7);  // reaches the end of a short strip
    ScrubPosition many(60, 0, ScrubPosition::TravelPerTab(60));
    many.Move(500.0);
    CHECK(many.NearestIndex() >= 7 && many.NearestIndex() <= 20);
  }

  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("all tab scrub model checks passed\n");
  return 0;
}
