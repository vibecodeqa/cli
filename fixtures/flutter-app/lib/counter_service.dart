/// Simple counter with an intentional smell or two, so scanners have
/// something honest to look at (a deliberately loose catch block).
class CounterService {
  int _count = 0;

  int get count => _count;

  void increment() {
    _count += 1;
  }

  int parseCount(String raw) {
    try {
      return int.parse(raw);
    } catch (e) {
      return 0;
    }
  }
}
