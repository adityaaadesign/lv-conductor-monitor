// Keeps reports that could not be sent (Wi-Fi or server down) so they can be sent later.
// When the buffer is full the OLDEST report is dropped and counted.
// After reconnecting, the firmware sends the newest report first and then this backlog;
// the server stores the backlog as history (DATA_CONTRACT.md §4).
#pragma once

#include "types.h"

namespace lvmon {

template <int CAPACITY>
class ReportBuffer {
 public:
  void push(const Report& r) {
    if (count_ == CAPACITY) {          // full: forget the oldest
      head_ = (head_ + 1) % CAPACITY;
      count_--;
      dropped_++;
    }
    items_[(head_ + count_) % CAPACITY] = r;
    count_++;
  }
  bool empty() const { return count_ == 0; }
  int size() const { return count_; }
  unsigned dropped() const { return dropped_; }
  const Report& oldest() const { return items_[head_]; }
  void popOldest() {
    if (count_ == 0) return;
    head_ = (head_ + 1) % CAPACITY;
    count_--;
  }

 private:
  Report items_[CAPACITY];
  int head_ = 0;
  int count_ = 0;
  unsigned dropped_ = 0;
};

}  // namespace lvmon
